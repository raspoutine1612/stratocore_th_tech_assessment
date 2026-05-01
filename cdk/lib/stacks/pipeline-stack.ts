import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';

/**
 * PipelineStack — AWS CodePipeline CI/CD.
 *
 * Stages:
 *  1. Source  — GitHub via CodeStar Connection (created once manually in the console).
 *  2. Build   — CodeBuild: docker build + push to ECR (latest + short SHA tags).
 *  3. Deploy  — CodeBuild: rolling ECS update + App Runner deployment trigger.
 *
 * Required context:
 *  --context githubOwner=<owner>
 *  --context githubRepo=<repo>
 *  --context githubConnectionArn=arn:aws:codestar-connections:...
 *
 * Optional context:
 *  --context githubBranch=<branch>   (default: main)
 *
 * One-time setup before deploying this stack:
 *  AWS Console → Developer Tools → Connections → Create connection → GitHub
 *  Authorize the connection, then copy the ARN.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubOwner = this.node.tryGetContext('githubOwner') as string;
    const githubRepo = this.node.tryGetContext('githubRepo') as string;
    const githubBranch = (this.node.tryGetContext('githubBranch') as string) ?? 'main';
    const connectionArn = this.node.tryGetContext('githubConnectionArn') as string;

    if (!githubOwner || !githubRepo || !connectionArn) {
      throw new Error(
        'Missing context. Pass: --context githubOwner=X --context githubRepo=X --context githubConnectionArn=X',
      );
    }

    const p = `/${PROJECT_PREFIX}`;

    const ecrRepoUri = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-uri`);
    const ecrRepoArn = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-arn`);
    const ecsClusterName = ssm.StringParameter.valueForStringParameter(this, `${p}/ecs-cluster-name`);
    const ecsServiceName = ssm.StringParameter.valueForStringParameter(this, `${p}/ecs-service-name`);
    const appRunnerArn = ssm.StringParameter.valueForStringParameter(this, `${p}/app-runner-service-arn`);

    const sourceOutput = new codepipeline.Artifact('Source');
    const buildOutput = new codepipeline.Artifact('Build');

    // Stage 2 — build Docker image and push to ECR.
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      description: 'Builds and pushes the Docker image to ECR',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Docker daemon requires privileged mode in CodeBuild.
      },
      environmentVariables: {
        ECR_REPO_URI: { value: ecrRepoUri },
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
            commands: [
              'docker build -t $ECR_REPO_URI:$IMAGE_TAG -t $ECR_REPO_URI:latest ./app',
            ],
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

    // ecr:GetAuthorizationToken has no resource-level restriction — * is required by AWS.
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:CompleteLayerUpload',
        'ecr:InitiateLayerUpload',
        'ecr:PutImage',
        'ecr:UploadLayerPart',
      ],
      resources: [ecrRepoArn],
    }));

    // Stage 3 — trigger rolling ECS update and App Runner deployment.
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      description: 'Triggers ECS rolling update and App Runner redeployment',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        ECS_CLUSTER: { value: ecsClusterName },
        ECS_SERVICE: { value: ecsServiceName },
        APP_RUNNER_ARN: { value: appRunnerArn },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment',
              'aws apprunner start-deployment --service-arn $APP_RUNNER_ARN',
            ],
          },
        },
      }),
    });

    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService'],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:service/${ecsClusterName}/${ecsServiceName}`,
      ],
    }));
    deployProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apprunner:StartDeployment'],
      resources: [appRunnerArn],
    }));

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${PROJECT_PREFIX}-pipeline`,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new actions.CodeStarConnectionsSourceAction({
              actionName: 'GitHub',
              owner: githubOwner,
              repo: githubRepo,
              branch: githubBranch,
              connectionArn,
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'BuildAndPush',
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'DeployToEcsAndAppRunner',
              project: deployProject,
              input: buildOutput,
            }),
          ],
        },
      ],
    });
  }
}
