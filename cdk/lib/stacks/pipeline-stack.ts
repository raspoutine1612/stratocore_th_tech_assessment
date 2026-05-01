import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { LogGroup } from '../constructs/observability/log-group';
import { KmsKey } from '../constructs/security/kms-key';

/**
 * PipelineStack — AWS CodePipeline CI/CD.
 *
 * Stages:
 *  1. Source  — GitHub via CodeStar Connection (managed by this stack).
 *  2. Build   — CodeBuild: docker build + push to ECR (latest + short SHA tags).
 *  3. Deploy  — CodeBuild: rolling ECS update + App Runner deployment trigger.
 *
 * Required context (set in cdk.json):
 *  githubOwner           — GitHub username or org
 *  githubRepo            — repository name
 *  githubConnectionArn   — ARN of an AVAILABLE AWS CodeConnections connection
 *                          (arn:aws:codeconnections:...). Must be created and
 *                          authorized once in the AWS Console before deploying.
 *
 * Optional context:
 *  githubBranch          — branch to track (default: main)
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubOwner = this.node.tryGetContext('githubOwner') as string;
    const githubRepo = this.node.tryGetContext('githubRepo') as string;
    const githubBranch = (this.node.tryGetContext('githubBranch') as string) ?? 'main';
    const connectionArn = this.node.tryGetContext('githubConnectionArn') as string;

    if (!githubOwner || !githubRepo || !connectionArn) {
      // Annotations.addError defers the failure to this stack's own synthesis,
      // so other stacks can still be deployed without this context.
      cdk.Annotations.of(this).addError(
        'Missing context: githubOwner, githubRepo, and githubConnectionArn must be set in cdk.json',
      );
      return;
    }

    // Publish the connection ARN to SSM so other stacks can reference it.
    new ssm.StringParameter(this, 'GitHubConnectionArn', {
      parameterName: `/${PROJECT_PREFIX}/github-connection-arn`,
      stringValue: connectionArn,
      description: 'CodeConnections ARN for GitHub — created and authorized manually in the AWS Console',
    });

    const p = `/${PROJECT_PREFIX}`;

    const ecrRepoUri = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-uri`);
    const ecrRepoArn = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-arn`);
    const ecsClusterName = ssm.StringParameter.valueForStringParameter(this, `${p}/ecs-cluster-name`);
    const ecsServiceName = ssm.StringParameter.valueForStringParameter(this, `${p}/ecs-service-name`);
    const lambdaFunctionName = ssm.StringParameter.valueForStringParameter(this, `${p}/lambda-function-name`);

    const sourceOutput = new codepipeline.Artifact('Source');

    // One KMS key shared by both pipeline log groups.
    const logKey = new KmsKey(this, 'PipelineLogKey', {
      description: 'Encrypts CodeBuild pipeline logs in CloudWatch',
    });
    const buildLogGroup = new LogGroup(this, 'BuildLogGroup', {
      logGroupName: '/file-api/pipeline/build',
      encryptionKey: logKey,
    });
    const deployLogGroup = new LogGroup(this, 'DeployLogGroup', {
      logGroupName: '/file-api/pipeline/deploy',
      encryptionKey: logKey,
    });
    const lintLogGroup = new LogGroup(this, 'LintLogGroup', {
      logGroupName: '/file-api/pipeline/quality/lint',
      encryptionKey: logKey,
    });
    const typecheckLogGroup = new LogGroup(this, 'TypeCheckLogGroup', {
      logGroupName: '/file-api/pipeline/quality/typecheck',
      encryptionKey: logKey,
    });
    const securityLogGroup = new LogGroup(this, 'SecurityLogGroup', {
      logGroupName: '/file-api/pipeline/quality/security',
      encryptionKey: logKey,
    });

    // Quality gate — 3 projects run in parallel within the same stage.
    const lintProject = new codebuild.PipelineProject(this, 'LintProject', {
      description: 'ruff check + ruff format',
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      logging: { cloudWatch: { logGroup: lintLogGroup.logGroup, enabled: true } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.12' },
            commands: ['pip install ruff'],
          },
          build: {
            commands: [
              'ruff check app/',
              'ruff format --check app/',
            ],
          },
        },
      }),
    });

    const typecheckProject = new codebuild.PipelineProject(this, 'TypeCheckProject', {
      description: 'mypy static type checking',
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      logging: { cloudWatch: { logGroup: typecheckLogGroup.logGroup, enabled: true } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.12' },
            commands: ['pip install mypy -r app/requirements.txt'],
          },
          build: {
            commands: ['mypy app/'],
          },
        },
      }),
    });

    const securityProject = new codebuild.PipelineProject(this, 'SecurityProject', {
      description: 'bandit SAST + pip-audit dependency scan',
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      logging: { cloudWatch: { logGroup: securityLogGroup.logGroup, enabled: true } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.12' },
            commands: ['pip install bandit pip-audit -r app/requirements.txt'],
          },
          build: {
            commands: [
              'bandit -r app/ -ll',
              'pip-audit -r app/requirements.txt',
            ],
          },
        },
      }),
    });

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
      logging: {
        cloudWatch: {
          logGroup: buildLogGroup.logGroup,
          prefix: 'build',
          enabled: true,
        },
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
      logging: {
        cloudWatch: {
          logGroup: deployLogGroup.logGroup,
          prefix: 'deploy',
          enabled: true,
        },
      },
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        ECS_CLUSTER: { value: ecsClusterName },
        ECS_SERVICE: { value: ecsServiceName },
        LAMBDA_FUNCTION_NAME: { value: lambdaFunctionName },
        ECR_REPO_URI: { value: ecrRepoUri },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // Update ECS service — forces a new task deployment with the latest image.
              'aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment',
              // Update Lambda function image — points the function to the newly pushed image.
              'aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --image-uri $ECR_REPO_URI:latest',
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
      actions: ['lambda:UpdateFunctionCode'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:*`,
      ],
    }));

    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch,
      connectionArn,
      output: sourceOutput,
      // triggerOnPush defaults to true. For V2 pipelines this creates a webhook-based
      // trigger (not polling). Do not set it to false — that breaks the trigger.
    });

    // PipelineType.V2 uses webhook-based triggers instead of polling.
    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${PROJECT_PREFIX}-pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'QualityGate',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Lint',
              project: lintProject,
              input: sourceOutput,
              runOrder: 1,
            }),
            new actions.CodeBuildAction({
              actionName: 'TypeCheck',
              project: typecheckProject,
              input: sourceOutput,
              runOrder: 1,
            }),
            new actions.CodeBuildAction({
              actionName: 'Security',
              project: securityProject,
              input: sourceOutput,
              runOrder: 1,
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
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'DeployToEcsAndAppRunner',
              project: deployProject,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });
  }
}
