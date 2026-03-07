import { Plugin } from 'obsidian';
import { patchGraphEngine } from './patch';

export default class LocalGraphTagLinksPlugin extends Plugin {
  private unpatch: (() => void) | null = null;

  async onload(): Promise<void> {
    // Patch as soon as the workspace is ready (may already have a local graph open)
    this.app.workspace.onLayoutReady(() => this.tryPatch());

    // Also watch for the user opening a local graph for the first time
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.tryPatch()),
    );
  }

  onunload(): void {
    this.unpatch?.();
    this.unpatch = null;
    // Force-refresh any open local graph so the injected nodes disappear
    for (const leaf of this.app.workspace.getLeavesOfType('localgraph')) {
      (leaf.view as any)?.engine?.render?.();
    }
  }

  private tryPatch(): void {
    if (this.unpatch) return; // already patched — prototype patch covers all instances

    const engine = this.getLocalGraphEngine();
    if (!engine) return;

    this.unpatch = patchGraphEngine(this.app, engine);

    // Immediately re-render any leaves that are already open
    if (this.unpatch) {
      for (const leaf of this.app.workspace.getLeavesOfType('localgraph')) {
        (leaf.view as any)?.engine?.render?.();
      }
    }
  }

  private getLocalGraphEngine(): any {
    const leaf = this.app.workspace.getLeavesOfType('localgraph')[0];
    return (leaf?.view as any)?.engine ?? null;
  }
}
