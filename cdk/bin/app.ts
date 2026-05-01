#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PROJECT_PREFIX } from '../lib/constants';
import { AppRunnerStack } from '../lib/stacks/app-runner-stack';
import { EcsStack } from '../lib/stacks/ecs-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { PipelineStack } from '../lib/stacks/pipeline-stack';
import { SharedStack } from '../lib/stacks/shared-stack';

/**
 * CDK entrypoint — instantiates all stacks in deployment order.
 *
 * Region is resolved from (in priority order):
 *  1. --context region=<value>
 *  2. AWS_REGION environment variable
 *  3. Default: us-east-1
 *
 * All stacks and resources are tagged automatically:
 *   Name=file-api, Project=file-api, Version=<APP_VERSION>
 * CDK propagates Tags.of(app) to every resource in every stack.
 *
 * APP_VERSION is injected by GitHub Actions (git tag or SHA).
 * Locally it defaults to "local".
 * Before deploying NetworkStack, store the ACM certificate ARN in SSM:
 *   aws ssm put-parameter \
 *     --name /file-api/certificate-arn \
 *     --value "arn:aws:acm:REGION:ACCOUNT:certificate/ID" \
 *     --type String
 */

const app = new cdk.App();

const region: string =
  app.node.tryGetContext('region') ?? process.env['AWS_REGION'] ?? 'us-east-1';

const account: string | undefined =
  process.env['CDK_DEFAULT_ACCOUNT'] ?? process.env['AWS_ACCOUNT_ID'];

const env: cdk.Environment = { region, account };

const version: string = process.env['APP_VERSION'] ?? 'local';

cdk.Tags.of(app).add('Name', PROJECT_PREFIX);
cdk.Tags.of(app).add('Project', PROJECT_PREFIX);
cdk.Tags.of(app).add('Version', version);

new SharedStack(app, `${PROJECT_PREFIX}-shared`, { env });
new NetworkStack(app, `${PROJECT_PREFIX}-network`, { env });
new EcsStack(app, `${PROJECT_PREFIX}-ecs`, { env });
new AppRunnerStack(app, `${PROJECT_PREFIX}-app-runner`, { env });
new PipelineStack(app, `${PROJECT_PREFIX}-pipeline`, { env });