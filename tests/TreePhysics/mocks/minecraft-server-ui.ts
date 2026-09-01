interface PendingForm {
  readonly player: unknown;
  resolve(response: { canceled: boolean }): void;
}

const pendingForms: PendingForm[] = [];

export class ActionFormData {
  title(_text: string): this { return this; }
  body(_text: string): this { return this; }

  show(player: unknown): Promise<{ canceled: boolean }> {
    return new Promise(resolve => pendingForms.push({ player, resolve }));
  }
}

export const testForms = {
  closeNext(): void {
    const pending = pendingForms.shift();
    if (!pending) throw new Error("No action form is pending.");
    pending.resolve({ canceled: true });
  },
  pendingCount(): number {
    return pendingForms.length;
  },
  reset(): void {
    pendingForms.length = 0;
  }
};
