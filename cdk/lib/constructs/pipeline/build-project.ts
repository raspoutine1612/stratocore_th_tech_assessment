import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface BuildProjectProps {
  /** Log group where CodeBuild writes build output. */
  readonly logGroup: logs.ILogGroup;
  /** ECR repository URI injected as ECR_REPO_URI into the build environment. */
  readonly ecrRepoUri: string;
}

/**
 * CodeBuild project that builds the Docker image and pushes it to ECR.
 *
 * Tags the image with both the short commit SHA and "latest".
 * ECR push permissions are granted via grantEcrPush().
 */
export class BuildProject extends Construct {
  public readonly project: codebuild.PipelineProject;

  constructor(scope: Construct, id: string, props: BuildProjectProps) {
    super(scope, id);

    this.project = new codebuild.PipelineProject(this, 'Project', {
      description: 'Builds and pushes the Docker image to ECR',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Docker daemon requires privileged mode in CodeBuild.
      },
      environmentVariables: {
        ECR_REPO_URI: { value: props.ecrRepoUri },
      },
      logging: {
        cloudWatch: { logGroup: props.logGroup, enabled: true },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI',
              'IMAGE_TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',
            ],
          },
          build: {
            commands: ['docker build -t $ECR_REPO_URI:$IMAGE_TAG -t $ECR_REPO_URI:latest ./app'],
          },
          post_build: {
            commands: [
              'docker push $ECR_REPO_URI:$IMAGE_TAG',
              'docker push $ECR_REPO_URI:latest',
            ],
          },
        },
      }),
    });
  }

  /**
   * Grant the CodeBuild role permission to push images to the given ECR repository.
   *
   * ecr:GetAuthorizationToken has no resource-level constraint — AWS requires *.
   * All other actions are scoped to the specific repository ARN.
   */
  public grantEcrPush(repositoryArn: string): void {
    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:CompleteLayerUpload',
        'ecr:InitiateLayerUpload',
        'ecr:PutImage',
        'ecr:UploadLayerPart',
      ],
      resources: [repositoryArn],
    }));
  }
}
