import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface EcsFargateProps {
  /** VPC in which to run the Fargate tasks (private subnets). */
  readonly vpc: ec2.IVpc;
  /** HTTPS listener to register the ECS target group on. */
  readonly httpListener: elbv2.IApplicationListener;
  /** Full ECR image URI including tag. */
  readonly imageUri: string;
  /** Log group for container stdout/stderr via the awslogs driver. */
  readonly logGroup: logs.ILogGroup;
  /** Task role — grants the container access to S3, DynamoDB. */
  readonly taskRole: iam.IRole;
  /** Execution role — grants ECS to pull the image and write to CloudWatch Logs. */
  readonly executionRole: iam.IRole;
  /** Environment variables injected into the container at runtime. */
  readonly environment: Record<string, string>;
  /**
   * Container port.
   * @default 8000
   */
  readonly containerPort?: number;
  /**
   * Listener rule priority. Must be unique across all rules on the listener.
   * Lower numbers are evaluated first.
   * @default 100
   */
  readonly listenerRulePriority?: number;
  /**
   * Fargate task vCPU units (256 = 0.25 vCPU).
   * Valid values: 256, 512, 1024, 2048, 4096.
   * @default 256
   */
  readonly cpu?: number;
  /**
   * Fargate task memory in MiB.
   * Must be compatible with the chosen cpu value — see AWS Fargate pricing page.
   * @default 512
   */
  readonly memoryLimitMiB?: number;
  /**
   * Number of tasks to run simultaneously.
   * @default 1
   */
  readonly desiredCount?: number;
}

/**
 * An ECS Fargate cluster, task definition, and service wired to an ALB.
 *
 * Tasks run in private subnets. The ALB security group is the only allowed inbound source.
 * Works with both constructed and imported ALB listeners.
 */
export class EcsFargate extends Construct {
  /** The underlying Fargate service. */
  public readonly service: ecs.FargateService;
  /** Security group attached to the Fargate tasks. */
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsFargateProps) {
    super(scope, id);

    const port = props.containerPort ?? 8000;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      // containerInsights was deprecated — containerInsightsV2 is the current API.
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      taskRole: props.taskRole,
      executionRole: props.executionRole,
      cpu: props.cpu ?? 256,
      memoryLimitMiB: props.memoryLimitMiB ?? 512,
    });

    taskDefinition.addContainer('Api', {
      image: ecs.ContainerImage.fromRegistry(props.imageUri),
      portMappings: [{ containerPort: port }],
      environment: props.environment,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'ecs',
      }),
      readonlyRootFilesystem: true,
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'ECS tasks - allows inbound from ALB only',
      allowAllOutbound: true,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: props.desiredCount ?? 1,
      assignPublicIp: false,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [
        this.service.loadBalancerTarget({
          containerName: 'Api',
          containerPort: port,
        }),
      ],
      healthCheck: { path: '/health' },
    });

    // addTargetGroups() without conditions modifies the default action, which is forbidden
    // on an imported listener. CfnListenerRule (L1) works with any listener ARN directly.
    new elbv2.CfnListenerRule(this, 'ListenerRule', {
      listenerArn: props.httpListener.listenerArn,
      priority: props.listenerRulePriority ?? 100,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/*'] } }],
      actions: [{ type: 'forward', targetGroupArn: targetGroup.targetGroupArn }],
    });
  }

  /**
   * Allow inbound traffic from the given security group (typically the ALB).
   */
  public allowInboundFrom(source: ec2.ISecurityGroup, port: number = 8000): void {
    this.securityGroup.addIngressRule(
      ec2.Peer.securityGroupId(source.securityGroupId),
      ec2.Port.tcp(port),
      'Allow inbound from ALB',
    );
  }
}
