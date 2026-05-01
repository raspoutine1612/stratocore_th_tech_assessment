import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { BuildProject } from '../constructs/pipeline/build-project';
import { DeployProject } from '../constructs/pipeline/deploy-project';
import { LogGroup } from '../constructs/observability/log-group';
import { KmsKey } from '../constructs/security/kms-key';

/**
 * PipelineStack — AWS CodePipeline CI/CD.
 *
 * Stages:
 *  1. Source      — GitHub via CodeStar Connection.
 *  2. QualityGate — ruff, mypy, bandit, pip-audit (parallel).
 *  3. Build       — Docker build + ECR push (latest + short SHA tags).
 *  4. Deploy      — Rolling ECS update + Lambda image update.
 *
 * Required context (set in cdk.json or via --context):
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

    // One KMS key for all pipeline log groups.
    const logKey = new KmsKey(this, 'PipelineLogKey', {
      description: 'Encrypts CodeBuild pipeline logs in CloudWatch',
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
    const buildLogGroup = new LogGroup(this, 'BuildLogGroup', {
      logGroupName: '/file-api/pipeline/build',
      encryptionKey: logKey,
    });
    const deployLogGroup = new LogGroup(this, 'DeployLogGroup', {
      logGroupName: '/file-api/pipeline/deploy',
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
            commands: ['ruff check app/', 'ruff format --check app/'],
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
          build: { commands: ['mypy app/'] },
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
            commands: ['bandit -r app/ -ll', 'pip-audit -r app/requirements.txt'],
          },
        },
      }),
    });

    const buildProject = new BuildProject(this, 'BuildProject', {
      logGroup: buildLogGroup.logGroup,
      ecrRepoUri,
    });
    buildProject.grantEcrPush(ecrRepoArn);

    const deployProject = new DeployProject(this, 'DeployProject', {
      logGroup: deployLogGroup.logGroup,
      ecsClusterName,
      ecsServiceName,
      lambdaFunctionName,
      ecrRepoUri,
    });
    deployProject.grantEcsDeploy(
      `arn:aws:ecs:${this.region}:${this.account}:service/${ecsClusterName}/${ecsServiceName}`,
    );
    deployProject.grantLambdaDeploy(
      `arn:aws:lambda:${this.region}:${this.account}:function:${lambdaFunctionName}`,
    );

    // PipelineType.V2 uses webhook-based triggers instead of polling.
    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${PROJECT_PREFIX}-pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
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
              // triggerOnPush defaults to true — creates a webhook, not polling.
            }),
          ],
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
              project: buildProject.project,
              input: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'DeployToEcsAndLambda',
              project: deployProject.project,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });
  }
}
