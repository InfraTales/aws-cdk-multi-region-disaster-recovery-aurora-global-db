import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';

interface NetworkingStackProps {
  config?: any;
  kmsKey: kms.IKey;
}

export class NetworkingStack extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly isolatedSubnets: ec2.ISubnet[];
  public albSecurityGroup: ec2.SecurityGroup;
  public ecsSecurityGroup: ec2.SecurityGroup;
  public dbSecurityGroup: ec2.SecurityGroup;
  public lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id);

    const { kmsKey } = props;

    // Create VPC with multi-AZ setup
    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 3,
      natGateways: 2, // Use 2 NAT gateways for high availability
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Store subnet references
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;
    this.isolatedSubnets = this.vpc.isolatedSubnets;

    // Create security groups
    this.createSecurityGroups();

    // Create VPC endpoints for AWS services
    this.createVpcEndpoints();

    // Create flow logs for monitoring
    this.createFlowLogs(kmsKey);
  }

  createSecurityGroups() {
    // ALB Security Group
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from anywhere'
    );

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere'
    );

    // ECS Security Group
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(8080),
      'Allow traffic from ALB'
    );

    // Database Security Group
    this.dbSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        vpc: this.vpc,
        description: 'Security group for Aurora database',
        allowAllOutbound: true,
      }
    );

    this.dbSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow MySQL traffic from ECS tasks'
    );

    // Lambda Security Group
    this.lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      'LambdaSecurityGroup',
      {
        vpc: this.vpc,
        description: 'Security group for Lambda functions',
        allowAllOutbound: true,
      }
    );

    this.lambdaSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from VPC'
    );
  }

  createVpcEndpoints() {
    // S3 VPC Endpoint
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DynamoDB VPC Endpoint
    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ECR VPC Endpoints
    this.vpc.addInterfaceEndpoint('ECREndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    this.vpc.addInterfaceEndpoint('ECRDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // CloudWatch Logs VPC Endpoint
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    // Secrets Manager VPC Endpoint
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // KMS VPC Endpoint
    this.vpc.addInterfaceEndpoint('KMSEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
    });
  }

  createFlowLogs(kmsKey: kms.IKey) {
    // Create CloudWatch Log Group for VPC Flow Logs
    const logGroup = new cdk.aws_logs.LogGroup(this, 'VPCFlowLogGroup', {
      logGroupName: `/aws/vpc/flowlogs/${this.vpc.vpcId}`,
      encryptionKey: kmsKey,
      retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
    });

    // Create IAM role for VPC Flow Logs
    const flowLogRole = new cdk.aws_iam.Role(this, 'VPCFlowLogRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal(
        'vpc-flow-logs.amazonaws.com'
      ),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/VPCFlowLogsDeliveryRolePolicy'
        ),
      ],
    });

    // Create VPC Flow Logs
    new ec2.FlowLog(this, 'VPCFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        logGroup,
        flowLogRole
      ),
    });
  }
}
