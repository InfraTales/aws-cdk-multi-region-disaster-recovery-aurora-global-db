import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

interface MonitoringStackProps {
  config: any;
  alb: any;
  ecsCluster: any;
  auroraCluster: any;
  globalTable: any;
}

export class MonitoringStack extends Construct {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id);

    const { config, alb, ecsCluster, auroraCluster, globalTable } = props;

    // Create SNS topic for alarms
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Operational Alarms',
      topicName: `tap-alarms-${config.environmentSuffix}-${config.regionName}`,
    });

    // Add email subscription
    this.alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription('ops-team@example.com')
    );

    // Create CloudWatch Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'OperationalDashboard', {
      dashboardName: `TapStack-${config.environmentSuffix}-${config.regionName}`,
      start: '-PT6H',
    });

    // Add dashboard widgets
    this.addDashboardWidgets(alb, ecsCluster, auroraCluster, globalTable);

    // Create operational alarms
    this.createOperationalAlarms(alb, ecsCluster, auroraCluster, globalTable);
  }

  addDashboardWidgets(
    alb: elbv2.ApplicationLoadBalancer,
    ecsCluster: ecs.Cluster,
    auroraCluster: rds.DatabaseCluster,
    globalTable: dynamodb.Table
  ) {
    // Application Performance Widget
    const appPerformanceWidget = new cloudwatch.GraphWidget({
      title: 'Application Performance',
      left: [alb.metricTargetResponseTime(), alb.metricRequestCount()],
      right: [
        alb.metricTargetResponseTime().with({
          statistic: 'p99',
        }),
      ],
    });

    // Database Performance Widget
    const dbPerformanceWidget = new cloudwatch.GraphWidget({
      title: 'Database Performance',
      left: [
        auroraCluster.metricCPUUtilization(),
        auroraCluster.metricDatabaseConnections(),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'ReadLatency',
          dimensionsMap: {
            DBClusterIdentifier: auroraCluster.clusterIdentifier,
          },
        }),
      ],
    });

    // ECS Performance Widget
    const ecsPerformanceWidget = new cloudwatch.GraphWidget({
      title: 'ECS Performance',
      left: [
        ecsCluster.metricCpuUtilization(),
        ecsCluster.metricMemoryUtilization(),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/ECS',
          metricName: 'RunningTaskCount',
          dimensionsMap: {
            ClusterName: ecsCluster.clusterName,
          },
        }),
      ],
    });

    // DynamoDB Performance Widget
    const dynamoPerformanceWidget = new cloudwatch.GraphWidget({
      title: 'DynamoDB Performance',
      left: [
        globalTable.metricConsumedReadCapacityUnits(),
        globalTable.metricConsumedWriteCapacityUnits(),
      ],
      right: [globalTable.metricThrottledRequests()],
    });

    // Transaction Rate Widget
    const transactionWidget = new cloudwatch.SingleValueWidget({
      title: 'Transaction Rate',
      metrics: [
        new cloudwatch.Metric({
          namespace: 'TapApplication',
          metricName: 'TransactionCount',
          statistic: 'Sum',
        }),
      ],
    });

    // Add all widgets to dashboard
    this.dashboard.addWidgets(
      appPerformanceWidget,
      dbPerformanceWidget,
      ecsPerformanceWidget,
      dynamoPerformanceWidget,
      transactionWidget
    );
  }

  createOperationalAlarms(
    alb: elbv2.ApplicationLoadBalancer,
    ecsCluster: ecs.Cluster,
    auroraCluster: rds.DatabaseCluster,
    globalTable: dynamodb.Table
  ) {
    // High CPU alarm for Aurora
    new cloudwatch.Alarm(this, 'DatabaseHighCpuAlarm', {
      metric: auroraCluster.metricCPUUtilization(),
      threshold: 80,
      evaluationPeriods: 2,
      alarmDescription: 'Aurora cluster CPU utilization is too high',
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // High latency alarm for ALB
    new cloudwatch.Alarm(this, 'HighLatencyAlarm', {
      metric: alb.metricTargetResponseTime(),
      threshold: 1000, // 1 second in milliseconds
      evaluationPeriods: 3,
      alarmDescription: 'Application latency is too high',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // Transaction rate alarm
    new cloudwatch.Alarm(this, 'LowTransactionRateAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'TapApplication',
        metricName: 'TransactionCount',
        statistic: 'Sum',
      }),
      threshold: 500, // Less than 500 transactions in 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'Transaction rate is below expected threshold',
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // ECS service health alarm
    new cloudwatch.Alarm(this, 'ECSServiceHealthAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: ecsCluster.clusterName,
        },
        statistic: 'Average',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'ECS service has no running tasks',
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // DynamoDB throttling alarm
    new cloudwatch.Alarm(this, 'DynamoDBThrottlingAlarm', {
      metric: globalTable.metricThrottledRequests(),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'DynamoDB is experiencing throttling',
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // ALB 5xx error alarm
    new cloudwatch.Alarm(this, 'ALB5xxErrorAlarm', {
      metric: alb.metricHttpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'ALB is returning too many 5xx errors',
    }).addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alarmTopic)
    );
  }
}
