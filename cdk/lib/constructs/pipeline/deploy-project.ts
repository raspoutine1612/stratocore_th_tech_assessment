import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface DeployProjectProps {
  /** Log group where CodeBuild writes deploy output. */
  readonly logGroup: logs.ILogGroup;
  /** ECS cluster name injected as ECS_CLUSTER. */
  readonly ecsClusterName: string;
  /** ECS service name injected as ECS_SERVICE. */
  readonly ecsServiceName: string;
  /** Lambda function name injected as LAMBDA_FUNCTION_NAME. */
  readonly lambdaFunctionName: string;
  /** ECR repository URI injected as ECR_REPO_URI (for the Lambda image update). */
  readonly ecrRepoUri: string;
}

/**
 * CodeBuild project that triggers a rolling ECS update and updates the Lambda image.
 *
 * Waits for ECS tasks to be stable before completing.
 * Deploy permissions are granted via grantEcsDeploy() and grantLambdaDeploy().
 */
export class DeployProject extends Construct {
  public readonly project: codebuild.PipelineProject;

  constructor(scope: Construct, id: string, props: DeployProjectProps) {
    super(scope, id);

    this.project = new codebuild.PipelineProject(this, 'Project', {
      description: 'Triggers ECS rolling update and Lambda function code update',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        ECS_CLUSTER: { value: props.ecsClusterName },
        ECS_SERVICE: { value: props.ecsServiceName },
        LAMBDA_FUNCTION_NAME: { value: props.lambdaFunctionName },
        ECR_REPO_URI: { value: props.ecrRepoUri },
      },
      logging: {
        cloudWatch: { logGroup: props.logGroup, enabled: true },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // Force a new ECS task deployment with the latest image, then wait for stability.
              'aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment',
              'aws ecs wait services-stable --cluster $ECS_CLUSTER --services $ECS_SERVICE',
              // Point Lambda to the newly pushed image.
              'aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --image-uri $ECR_REPO_URI:latest',
            ],
          },
        },
      }),
    });
  }

  /**
   * Grant permission to trigger and wait on ECS service deployments.
   *
   * ecs:DescribeServices is required by `aws ecs wait services-stable`.
   */
  public grantEcsDeploy(serviceArn: string): void {
    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [serviceArn],
    }));
  }

  /**
   * Grant permission to update the Lambda function's container image.
   */
  public grantLambdaDeploy(functionArn: string): void {
    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode'],
      resources: [functionArn],
    }));
  }
}
