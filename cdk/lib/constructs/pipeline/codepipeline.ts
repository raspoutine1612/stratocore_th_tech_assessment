import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CodePipelineProps {
  /**
   * AWS CodeStar connection ARN for the GitHub source.
   * Create the connection in the AWS Console (CodePipeline → Connections)
   * and store the ARN in SSM at /stratocore/{env}/github-connection-arn.
   */
  readonly githubConnectionArn: string;
  /** GitHub owner (user or organisation). */
  readonly githubOwner: string;
  /** GitHub repository name. */
  readonly githubRepo: string;
  /**
   * Branch to track.
   * @default "main"
   */
  readonly githubBranch?: string;
  /** ECR repository where Docker images are pushed. */
  readonly ecrRepository: ecr.IRepository;
  /**
   * IAM role for CodeBuild projects.
   * Must allow ECR push, CDK deploy, and SSM read.
   */
  readonly codeBuildRole: iam.IRole;
}

/**
 * A three-stage CodePipeline triggered by GitHub commits.
 *
 * Stage 1 — Quality Gate: ruff, mypy, bandit, pip-audit.
 * Stage 2 — Build: docker build + push to ECR, blocks on HIGH/CRITICAL CVEs.
 * Stage 3 — Deploy: cdk deploy for all four stacks in order.
 *
 * A failure at any stage stops downstream stages.
 */
export class CodePipeline extends Construct {
  /** The underlying CDK pipeline. */
  public readonly pipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: CodePipelineProps) {
    super(scope, id);

    const sourceOutput = new codepipeline.Artifact('Source');
    const buildOutput = new codepipeline.Artifact('Build');

    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      connectionArn: props.githubConnectionArn,
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: props.githubBranch ?? 'main',
      output: sourceOutput,
    });

    const qualityProject = new codebuild.PipelineProject(this, 'QualityGate', {
      role: props.codeBuildRole,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { python: '3.12' },
            commands: ['pip install ruff mypy bandit pip-audit -r app/requirements.txt'],
          },
          build: {
            commands: [
              'ruff check app/',
              'ruff format --check app/',
              'mypy app/',
              'bandit -r app/ -ll',
              'pip-audit -r app/requirements.txt',
            ],
          },
        },
      }),
    });

    const buildProject = new codebuild.PipelineProject(this, 'Build', {
      role: props.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // required for docker build
      },
      environmentVariables: {
        ECR_REPO_URI: { value: props.ecrRepository.repositoryUri },
        AWS_REGION: { value: cdk.Stack.of(this).region },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    });

    props.ecrRepository.grantPullPush(buildProject);

    const deployProject = new codebuild.PipelineProject(this, 'Deploy', {
      role: props.codeBuildRole,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm ci --prefix cdk'],
          },
          build: {
            commands: [
              'npx cdk deploy SharedStack --require-approval never --app "npx ts-node --prefer-ts-exts cdk/bin/app.ts"',
              'npx cdk deploy NetworkStack --require-approval never --app "npx ts-node --prefer-ts-exts cdk/bin/app.ts"',
              'npx cdk deploy EcsStack --require-approval never --app "npx ts-node --prefer-ts-exts cdk/bin/app.ts"',
              'npx cdk deploy AppRunnerStack --require-approval never --app "npx ts-node --prefer-ts-exts cdk/bin/app.ts"',
            ],
          },
        },
      }),
    });

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      crossAccountKeys: false,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'QualityGate',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'QualityGate',
              project: qualityProject,
              input: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Build',
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
              actionName: 'Deploy',
              project: deployProject,
              input: buildOutput,
            }),
          ],
        },
      ],
    });
  }
}
