import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { Notifier } from "open-caregiver-mcp";

/** Publishes caregiver alerts to an SNS topic (SMS / email subscriptions hang off the topic). */
export class SnsNotifier implements Notifier {
  constructor(private client: Pick<SNSClient, "send">, private topicArn: string, private timeoutMs = 3000, private log: (m: string) => void = console.error) {}

  async send(kind: Parameters<Notifier["send"]>[0], text: string): Promise<string | undefined> {
    // A slow or failing SMS path must never block or fail a dose that was already recorded.
    try {
      const publish = this.client.send(
        new PublishCommand({
          TopicArn: this.topicArn,
          Message: text,
          Subject: `CareOS ${kind}`.slice(0, 99),
          MessageAttributes: { kind: { DataType: "String", StringValue: kind } },
        }),
      );
      const res = await Promise.race([publish, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`SNS publish timed out after ${this.timeoutMs}ms`)), this.timeoutMs))]);
      return (res as { MessageId?: string }).MessageId;
    } catch (e) {
      this.log(`[sns] ${kind} not delivered: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }
}

/** Dev/offline notifier: prints what would be sent. */
export class ConsoleNotifier implements Notifier {
  sent: { kind: string; text: string }[] = [];
  async send(kind: Parameters<Notifier["send"]>[0], text: string) {
    this.sent.push({ kind, text });
    console.error(`[alert:${kind}] ${text}`);
    return `console-${this.sent.length}`;
  }
}
