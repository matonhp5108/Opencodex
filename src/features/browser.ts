import * as path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

export type ViewportName = "mobile" | "tablet" | "laptop" | "desktop";

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export const VIEWPORTS: Record<ViewportName, Viewport> = {
  mobile: {
    name: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    name: "tablet",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  laptop: {
    name: "laptop",
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  desktop: {
    name: "desktop",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

export function pickViewport(name?: string): Viewport {
  const key = (name || "laptop").toLowerCase() as ViewportName;
  return VIEWPORTS[key] ?? VIEWPORTS.laptop;
}

export interface ConsoleMessage {
  type: "error" | "warning" | "log" | "info" | "debug";
  text: string;
  location?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  failed: boolean;
  errorText?: string;
  resourceType?: string;
  durationMs?: number;
}

export function summarizeConsoleErrors(messages: ConsoleMessage[]): {
  errors: ConsoleMessage[];
  warnings: ConsoleMessage[];
} {
  const errors: ConsoleMessage[] = [];
  const warnings: ConsoleMessage[] = [];
  for (const message of messages) {
    if (message.type === "error") errors.push(message);
    else if (message.type === "warning") warnings.push(message);
  }
  return { errors, warnings };
}

export function summarizeNetworkErrors(
  requests: NetworkRequest[],
): NetworkRequest[] {
  return requests.filter((r) => r.failed || r.status >= 400);
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResponsiveGeometry {
  viewport: Viewport;
  documentWidth: number;
  documentHeight: number;
  scrollWidth: number;
  horizontalOverflow: boolean;
  elements: { selector: string; box: ElementBox }[];
  offscreen: string[];
}

export function analyzeGeometry(
  viewport: Viewport,
  documentWidth: number,
  scrollWidth: number,
  elements: { selector: string; box: ElementBox }[],
): ResponsiveGeometry {
  const offscreen: string[] = [];
  for (const element of elements) {
    const { box } = element;
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    if (
      box.x < 0 ||
      box.y < 0 ||
      right > viewport.width + 1 ||
      bottom > viewport.height + 1
    )
      offscreen.push(element.selector);
  }
  return {
    viewport,
    documentWidth,
    documentHeight: 0,
    scrollWidth,
    horizontalOverflow: scrollWidth > viewport.width + 1,
    elements,
    offscreen,
  };
}

export interface BrowserSessionOptions {
  url: string;
  viewport?: ViewportName;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  screenshotPath?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  dom: string;
  accessibility: unknown;
  console: ConsoleMessage[];
  network: NetworkRequest[];
  geometry?: ResponsiveGeometry;
}

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly installHint?: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

type PageLike = any;
type BrowserLike = any;

export class BrowserController {
  private browser: BrowserLike | undefined;
  private page: PageLike | undefined;
  private consoleLog: ConsoleMessage[] = [];
  private networkLog: NetworkRequest[] = [];
  private capturingConsole = false;
  private capturingNetwork = false;

  get consoleMessages(): ConsoleMessage[] {
    return this.consoleLog;
  }
  get networkRequests(): NetworkRequest[] {
    return this.networkLog;
  }

  private async loadPlaywright(): Promise<any> {
    try {
      return await import("playwright");
    } catch {
      throw new BrowserError(
        "Playwright is not installed in this workspace.",
        "npm install --no-save playwright && npx playwright install chromium",
      );
    }
  }

  async launch(options: BrowserSessionOptions): Promise<void> {
    const pw = await this.loadPlaywright();
    const viewport = pickViewport(options.viewport);
    this.consoleLog = [];
    this.networkLog = [];
    try {
      this.browser = await pw.chromium.launch({ headless: true });
    } catch (error) {
      try {
        this.browser = await pw.chromium.launch({
          headless: true,
          channel: "chrome",
        });
      } catch {
        throw new BrowserError(
          `Could not launch Chromium: ${error instanceof Error ? error.message : String(error)}`,
          "Install Google Chrome or run `npx playwright install chromium`.",
        );
      }
    }
    this.page = await this.browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    this.capturingConsole = options.captureConsole ?? true;
    this.capturingNetwork = options.captureNetwork ?? true;
    if (this.capturingConsole) {
      this.page.on("console", (msg: any) => {
        const type = msg.type() as ConsoleMessage["type"];
        if (type === "error" || type === "warning" || type === "log") {
          this.consoleLog.push({ type, text: msg.text() });
        }
      });
      this.page.on("pageerror", (err: any) => {
        this.consoleLog.push({
          type: "error",
          text: String(err?.message ?? err),
        });
      });
    }
    if (this.capturingNetwork) {
      this.page.on("requestfailed", (req: any) => {
        this.networkLog.push({
          url: req.url(),
          method: req.method(),
          status: 0,
          failed: true,
          errorText: req.failure()?.errorText,
          resourceType: req.resourceType(),
        });
      });
      this.page.on("response", (res: any) => {
        this.networkLog.push({
          url: res.url(),
          method: res.request().method(),
          status: res.status(),
          failed: false,
          resourceType: res.request().resourceType(),
        });
      });
    }
    await this.page.goto(options.url, {
      waitUntil: options.waitUntil ?? "load",
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  async snapshot(): Promise<BrowserSnapshot> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const dom = await this.page.content();
    let accessibility: unknown = null;
    try {
      accessibility = this.page.accessibility?.snapshot
        ? await this.page.accessibility.snapshot()
        : await this.page.locator("body").ariaSnapshot();
    } catch {
      accessibility = null;
    }
    const title = await this.page.title();
    return {
      url: this.page.url(),
      title,
      dom,
      accessibility,
      console: [...this.consoleLog],
      network: [...this.networkLog],
    };
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new BrowserError("No active browser session.");
    await this.page.click(selector, { timeout: 10_000 });
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new BrowserError("No active browser session.");
    await this.page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  }

  async type(
    selector: string,
    text: string,
    options: { clear?: boolean; delayMs?: number } = {},
  ): Promise<void> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const locator = this.page.locator(selector).first();
    await locator.click({ timeout: 10_000 });
    if (options.clear ?? true) {
      await locator.press(
        process.platform === "darwin" ? "Meta+A" : "Control+A",
      );
      await locator.press("Backspace");
    }
    await locator.pressSequentially(text, {
      delay: Math.min(250, Math.max(0, options.delayMs ?? 24)),
      timeout: 30_000,
    });
  }

  async press(key: string, selector?: string): Promise<void> {
    if (!this.page) throw new BrowserError("No active browser session.");
    if (selector) {
      const locator = this.page.locator(selector).first();
      await locator.focus({ timeout: 10_000 });
      await locator.press(key, { timeout: 10_000 });
    } else {
      await this.page.keyboard.press(key);
    }
  }

  async evaluate<T = unknown>(fn: string | (() => T)): Promise<T> {
    if (!this.page) throw new BrowserError("No active browser session.");
    return this.page.evaluate(fn);
  }

  async collectGeometry(
    viewportName?: ViewportName,
  ): Promise<ResponsiveGeometry> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const viewport = pickViewport(viewportName);
    await this.page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const data = await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("*"));
      const sample = els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.id;
        })
        .slice(0, 200)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            selector: `#${el.id}`,
            box: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        });
      return {
        documentWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elements: sample,
      };
    });
    return analyzeGeometry(
      viewport,
      data.documentWidth,
      data.scrollWidth,
      data.elements,
    );
  }

  async screenshot(targetPath: string): Promise<string> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const resolved = targetPath.endsWith(".png")
      ? targetPath
      : `${targetPath}.png`;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await this.page.screenshot({ path: resolved, fullPage: true });
    return resolved;
  }

  async previewDataUrl(): Promise<string> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const image = await this.page.screenshot({
      type: "jpeg",
      quality: 72,
      fullPage: false,
      scale: "css",
    });
    return `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`;
  }

  async cursorPoint(
    selector: string,
  ): Promise<{ x: number; y: number } | undefined> {
    if (!this.page) throw new BrowserError("No active browser session.");
    const box = await this.page.locator(selector).first().boundingBox();
    const viewport = this.page.viewportSize();
    if (!box || !viewport?.width || !viewport.height) return undefined;
    return {
      x: Math.min(1, Math.max(0, (box.x + box.width / 2) / viewport.width)),
      y: Math.min(1, Math.max(0, (box.y + box.height / 2) / viewport.height)),
    };
  }

  get active(): boolean {
    return Boolean(this.page);
  }

  static fileUrl(localPath: string): string {
    return pathToFileURL(localPath).href;
  }

  async close(): Promise<void> {
    await this.browser?.close?.().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }
}
