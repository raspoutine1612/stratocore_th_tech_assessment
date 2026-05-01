import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LambdaFunctionProps {
  /** ECR repository that holds the container image. */
  readonly ecrRepository: ecr.IRepository;
  /**
   * Image tag to deploy.
   * @default 'latest'
   */
  readonly imageTag?: string;
  /**
   * IAM role the Lambda function assumes at runtime.
   * Must grant access to S3, DynamoDB, and ECR.
   */
  readonly executionRole: iam.IRole;
  /** Environment variables injected into the function at runtime. */
  readonly environment: Record<string, string>;
  /** CloudWatch log group where Lambda writes its output. */
  readonly logGroup: logs.ILogGroup;
  /**
   * Amount of memory allocated to the function, in MB.
   * @default 512
   */
  readonly memorySize?: number;
  /**
   * Maximum execution time before Lambda terminates the invocation.
   * API Gateway HTTP API has a hard limit of 29 seconds.
   * @default Duration.seconds(29)
   */
  readonly timeout?: cdk.Duration;
  /**
   * VPC to deploy the function into. When provided, the function runs in
   * private subnets and can reach VPC resources through VPC endpoints.
   * @default undefined — function runs outside any VPC
   */
  readonly vpc?: ec2.IVpc;
  /**
   * Subnets within the VPC to place the Lambda ENIs.
   * Ignored when vpc is not set.
   * @default SubnetType.PRIVATE_WITH_EGRESS
   */
  readonly vpcSubnets?: ec2.SubnetSelection;
}

/**
 * A Lambda function that runs the FastAPI app packaged as a container image.
 *
 * Uses the same ECR image as ECS — Mangum adapts ASGI ↔ Lambda event format.
 * Deployed inside the VPC so it can reach S3 and DynamoDB without a public IP.
 */
export class LambdaFunction extends Construct {
  /** The underlying Lambda function. */
  public readonly fn: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: LambdaFunctionProps) {
    super(scope, id);

    this.fn = new lambda.DockerImageFunction(this, 'Function', {
      // fromEcr accepts an IRepository — no raw URI string needed.
      code: lambda.DockerImageCode.fromEcr(props.ecrRepository, {
        tagOrDigest: props.imageTag ?? 'latest',
      }),
      role: props.executionRole,
      logGroup: props.logGroup,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? cdk.Duration.seconds(29),
      environment: props.environment,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets ?? (props.vpc ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } : undefined),
    });
  }
}
