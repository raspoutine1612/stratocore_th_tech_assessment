import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { LambdaFunction } from '../constructs/compute/lambda-function';
import { LogGroup } from '../constructs/observability/log-group';
import { IamRole } from '../constructs/security/iam-role';
import { KmsKey } from '../constructs/security/kms-key';
import { grantStorageAccess } from './storage-grants';

export interface LambdaApiProps {
  /** ECR repository that holds the container image. */
  readonly ecrRepository: ecr.IRepository;
  readonly bucketName: string;
  readonly bucketArn: string;
  readonly bucketKmsKeyArn: string;
  readonly tableName: string;
  readonly tableArn: string;
  readonly tableKmsKeyArn: string;
  /**
   * VPC to run the Lambda inside. The function uses private subnets.
   * @default undefined — function runs outside any VPC
   */
  readonly vpc?: ec2.IVpc;
  /** @default RemovalPolicy.RETAIN */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * The serverless compute target for stratocore — Lambda + API Gateway HTTP API.
 *
 * Creates:
 *  - KMS key + CloudWatch log group for Lambda logs
 *  - Execution role with scoped S3, DynamoDB, and ECR grants
 *  - Lambda DockerImageFunction (same ECR image as ECS, adapted by Mangum)
 *  - API Gateway HTTP API with a default $default route → Lambda integration
 *
 * API Gateway HTTP API is used over REST API because:
 *  - Lower latency and cost
 *  - Simpler configuration for a proxy-style integration
 *  - Native HTTPS endpoint with no additional configuration
 */
export class LambdaApi extends Construct {
  /** The HTTPS URL of the API Gateway endpoint. */
  public readonly apiUrl: string;
  /** The Lambda function ARN. Needed to update the function from the pipeline. */
  public readonly functionArn: string;
  /** The Lambda function name. Needed to update the function from the pipeline. */
  public readonly functionName: string;

  constructor(scope: Construct, id: string, props: LambdaApiProps) {
    super(scope, id);

    const logKey = new KmsKey(this, 'LogKey', {
      description: 'Encrypts Lambda function logs in CloudWatch',
      removalPolicy: props.removalPolicy,
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: '/file-api/lambda/app',
      encryptionKey: logKey,
      removalPolicy: props.removalPolicy,
    });

    // Lambda execution role — grants the function permission to run and access resources.
    // AWSLambdaBasicExecutionRole is the minimum needed to write logs.
    // AWSLambdaVPCAccessExecutionRole is added when the function runs in a VPC.
    const managedPolicies = [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ];
    if (props.vpc) {
      managedPolicies.push(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      );
    }

    const executionRole = new IamRole(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows the stratocore Lambda function to access S3, DynamoDB, and ECR',
      managedPolicies,
    });

    grantStorageAccess(this, executionRole.role, {
      bucketArn: props.bucketArn,
      bucketKmsKeyArn: props.bucketKmsKeyArn,
      tableArn: props.tableArn,
      tableKmsKeyArn: props.tableKmsKeyArn,
    });

    // Grant the execution role permission to pull the container image from ECR.
    props.ecrRepository.grantPull(executionRole.role);

    const lambdaFn = new LambdaFunction(this, 'Function', {
      ecrRepository: props.ecrRepository,
      executionRole: executionRole.role,
      logGroup: logGroup.logGroup,
      environment: {
        // AWS_REGION is injected automatically by the Lambda runtime — do not set it manually.
        S3_BUCKET_NAME: props.bucketName,
        DYNAMO_TABLE_NAME: props.tableName,
      },
      vpc: props.vpc,
    });

    // API Gateway HTTP API — the simplest way to expose Lambda over HTTPS.
    // The $default route catches all methods and paths and forwards to Lambda.
    // This mirrors how App Runner proxied all traffic to the container.
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'file-api-lambda',
      defaultIntegration: new integrations.HttpLambdaIntegration(
        'LambdaIntegration',
        lambdaFn.fn,
      ),
    });

    this.apiUrl = httpApi.apiEndpoint;
    this.functionArn = lambdaFn.fn.functionArn;
    this.functionName = lambdaFn.fn.functionName;
  }
}
