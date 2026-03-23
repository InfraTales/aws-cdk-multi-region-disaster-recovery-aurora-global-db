import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';

interface DatabaseStackProps {
  vpc: ec2.IVpc;
  config: any;
  kmsKey: any;
  dbSecurityGroup: ec2.SecurityGroup;
}

export class DatabaseStack extends Construct {
  public readonly cluster: rds.IDatabaseCluster;
  public readonly credentials: secretsmanager.Secret;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    const { vpc, config, kmsKey } = props;

    // Create credentials secret
    this.credentials = new secretsmanager.Secret(this, 'DbCredentials', {
      description: 'Aurora database credentials',
      secretName: `tap-db-credentials-${config.environmentSuffix}-${config.regionName}`,
      encryptionKey: kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        passwordLength: 32,
      },
    });

    // Create database security group
    this.securityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Security group for Aurora database',
      allowAllOutbound: true,
    });

    // Create subnet group
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      description: 'Subnet group for Aurora database',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Create Aurora parameter group for optimization
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
      }),
      description: 'Custom parameter group for Aurora MySQL',
      parameters: {
        slow_query_log: '1',
        general_log: '1',
        log_output: 'FILE',
        max_connections: '1000',
        innodb_buffer_pool_size: '{DBInstanceClassMemory*3/4}',
      },
    });

    // Create Aurora Global Database (if primary region)
    if (config.isPrimary) {
      const globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
        globalClusterIdentifier: `tap-global-cluster-${config.environmentSuffix}`,
        engine: 'aurora-mysql',
        engineVersion: '8.0.mysql_aurora.3.04.0',
        storageEncrypted: true,
      });

      this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
        engine: rds.DatabaseClusterEngine.auroraMysql({
          version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
        }),
        credentials: rds.Credentials.fromSecret(this.credentials),
        clusterIdentifier: `tap-aurora-${config.environmentSuffix}-${config.regionName}`,
        defaultDatabaseName: 'tapdb',
        instanceProps: {
          vpc,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.R6G,
            ec2.InstanceSize.XLARGE
          ),
          securityGroups: [this.securityGroup],
          parameterGroup,
        },
        instances: 2,
        backup: {
          retention: cdk.Duration.days(7),
          preferredWindow: '03:00-04:00',
        },
        cloudwatchLogsExports: ['error', 'general', 'slowquery', 'audit'],
        cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
        storageEncrypted: true,
        storageEncryptionKey: kmsKey,
        subnetGroup,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Associate with global cluster
      const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
      cfnCluster.addPropertyOverride(
        'GlobalClusterIdentifier',
        globalCluster.ref
      );
    } else {
      // Create secondary cluster for DR region
      this.cluster = new rds.DatabaseClusterFromSnapshot(
        this,
        'AuroraClusterDR',
        {
          snapshotIdentifier: `tap-aurora-snapshot-${config.environmentSuffix}`,
          engine: rds.DatabaseClusterEngine.auroraMysql({
            version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
          }),
          clusterIdentifier: `tap-aurora-dr-${config.environmentSuffix}-${config.regionName}`,
          instanceProps: {
            vpc,
            vpcSubnets: {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            instanceType: ec2.InstanceType.of(
              ec2.InstanceClass.R6G,
              ec2.InstanceSize.LARGE
            ),
            securityGroups: [this.securityGroup],
            parameterGroup,
          },
          instances: 1,
          backup: {
            retention: cdk.Duration.days(7),
            preferredWindow: '03:00-04:00',
          },
          cloudwatchLogsExports: ['error', 'general', 'slowquery'],
          cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
          storageEncrypted: true,
          storageEncryptionKey: kmsKey,
          subnetGroup,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }
      );
    }

    // Add read replicas for scaling
    if (config.isPrimary) {
      // Create monitoring role for enhanced monitoring
      const monitoringRole = new cdk.aws_iam.Role(this, 'RDSMonitoringRole', {
        assumedBy: new cdk.aws_iam.ServicePrincipal(
          'monitoring.rds.amazonaws.com'
        ),
        managedPolicies: [
          cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AmazonRDSEnhancedMonitoringRole'
          ),
        ],
      });

      for (let i = 0; i < 2; i++) {
        new rds.CfnDBInstance(this, `ReadReplica${i}`, {
          dbInstanceIdentifier: `tap-read-replica-${config.environmentSuffix}-${config.regionName}-${i}`,
          dbClusterIdentifier: this.cluster.clusterIdentifier,
          dbInstanceClass: 'db.r6g.large',
          engine: 'aurora-mysql',
          monitoringInterval: 60,
          monitoringRoleArn: monitoringRole.roleArn,
          publiclyAccessible: false,
        });
      }
    }
  }
}
