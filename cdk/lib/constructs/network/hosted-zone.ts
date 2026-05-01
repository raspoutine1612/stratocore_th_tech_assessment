import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface HostedZoneProps {
  /** The apex domain name, e.g. "file-api.click". */
  readonly domainName: string;
}

/**
 * Imports the Route 53 public hosted zone created automatically when a domain
 * is registered via Route 53 Domains.
 *
 * CDK looks up the hosted zone at synth time and caches the result in
 * cdk.context.json. The account and region must be set on the stack env.
 */
export class HostedZone extends Construct {
  /** The imported hosted zone. */
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: HostedZoneProps) {
    super(scope, id);

    this.hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.domainName,
    });
  }
}
