import type { MessageReceiptRepository } from "./message-receipt-repository";

type ReceiptEntitlements = {
  decideForUser(userId: string, key: "message.read_receipt.view"): Promise<{ allowed: boolean }>;
};

export class MessageReceiptService {
  constructor(
    private readonly repository: Pick<MessageReceiptRepository, "record" | "listForSender">,
    private readonly entitlements: ReceiptEntitlements,
  ) {}

  record(userId: string, input: unknown) {
    return this.repository.record(userId, input);
  }

  async listVisible(userId: string, conversationId: string, afterSequence: number) {
    const decision = await this.entitlements.decideForUser(userId, "message.read_receipt.view");
    if (!decision.allowed) return { visible: false, receipts: [] };
    return {
      visible: true,
      receipts: await this.repository.listForSender(userId, conversationId, afterSequence),
    };
  }
}
