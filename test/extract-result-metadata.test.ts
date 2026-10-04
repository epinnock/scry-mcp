import { describe, it, expect } from "vitest";
import { extractResultMetadata, isNativeSourceType, nativePlatformLabel } from "../src/utils/result-metadata";

/**
 * Records written by scry-build-processing-service (pipeline/vector-inserter.ts)
 * for a Storybook story. Field names here must stay in sync with that producer.
 */
const storybookJsonContent = {
  source_type: "storybook",
  filepath: "src/components/PricingCard.stories.tsx",
  componentFilePath: "src/components/PricingCard.tsx",
  testName: "Recommended",
  storyTitle: "Components/PricingCard",
  screenshotPath: "images/components-pricingcard-recommended.png",
  screenshotR2Url: "https://r2.example.com/proj/b1/pricingcard.png",
  inspection: {
    description: "A pricing tier card with a highlighted recommended badge.",
    tags: ["pricing", "card", "billing"],
    searchQueries: ["pricing plan card"],
    metadata: { imagePath: "x.png", model: "m", timestamp: "t" },
  },
};

describe("extractResultMetadata", () => {
  // ISSUES.md #6: leading with `filepath` pointed agents at the .stories file,
  // one import short of the component they were told to reuse.
  it("prefers the component file over the story file as the source path", () => {
    const meta = extractResultMetadata(storybookJsonContent);
    expect(meta.sourcePath).toBe("src/components/PricingCard.tsx");
    expect(meta.storyPath).toBe("src/components/PricingCard.stories.tsx");
  });

  it("falls back to the story file for rows indexed before componentFilePath existed", () => {
    const legacy = { ...storybookJsonContent };
    delete (legacy as { componentFilePath?: string }).componentFilePath;
    const meta = extractResultMetadata(legacy);
    expect(meta.sourcePath).toBe("src/components/PricingCard.stories.tsx");
  });

  it("surfaces story title and variant separately", () => {
    const meta = extractResultMetadata(storybookJsonContent);
    expect(meta.storyTitle).toBe("Components/PricingCard");
    expect(meta.variant).toBe("Recommended");
  });

  it("reads description and tags from the nested inspection object", () => {
    const meta = extractResultMetadata(storybookJsonContent);
    expect(meta.description).toBe(
      "A pricing tier card with a highlighted recommended badge."
    );
    expect(meta.tags).toEqual(["pricing", "card", "billing"]);
  });

  it("reads the camelCase screenshot key written by the pipeline", () => {
    const meta = extractResultMetadata(storybookJsonContent);
    expect(meta.screenshotUrl).toBe("https://r2.example.com/proj/b1/pricingcard.png");
  });

  it("still reads legacy snake_case link fields", () => {
    const meta = extractResultMetadata({
      figma_url: "https://figma.com/f",
      github_url: "https://github.com/g",
      storybook_url: "https://view.scrymore.com/s",
      tags: ["legacy"],
    });
    expect(meta.figmaUrl).toBe("https://figma.com/f");
    expect(meta.githubUrl).toBe("https://github.com/g");
    expect(meta.storybookUrl).toBe("https://view.scrymore.com/s");
    expect(meta.tags).toEqual(["legacy"]);
  });

  it("accepts snake_case source path aliases", () => {
    expect(extractResultMetadata({ source_path: "a.tsx" }).sourcePath).toBe("a.tsx");
    expect(extractResultMetadata({ import_path: "b.tsx" }).sourcePath).toBe("b.tsx");
  });

  it("prefers inspection.tags over a top-level tags array", () => {
    const meta = extractResultMetadata({
      tags: ["top"],
      inspection: { tags: ["nested"] },
    });
    expect(meta.tags).toEqual(["nested"]);
  });

  it("returns undefined rather than empty strings or arrays", () => {
    const meta = extractResultMetadata({ filepath: "", tags: [] });
    expect(meta.sourcePath).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });

  it("handles image-upload records and missing json_content without throwing", () => {
    expect(extractResultMetadata(undefined).sourcePath).toBeUndefined();
    const upload = extractResultMetadata({
      source_type: "upload",
      filename: "screen.png",
      screenshotR2Url: "https://r2.example.com/u/screen.png",
      inspection: { description: "A login screen.", tags: ["login"] },
    });
    expect(upload.description).toBe("A login screen.");
    expect(upload.screenshotUrl).toBe("https://r2.example.com/u/screen.png");
    expect(upload.sourcePath).toBeUndefined();
  });
});

/**
 * feature capture-sources, guarantee-5: a row from a native source has no
 * live Storybook. Records here are what
 * scry-build-processing-service/src/pipeline/vector-inserter.ts writes into
 * `json_content` for a React Native on-device Storybook capture (contract
 * §5/§6): source_type "storybook-rn", platform "ios"/"android".
 */
const nativeJsonContent = {
  source_type: "storybook-rn",
  platform: "ios",
  filepath: "src/components/Button.stories.tsx",
  componentFilePath: "src/components/Button.tsx",
  testName: "Primary",
  storyTitle: "UI/Button",
  screenshotPath: "images/ui-button-primary.png",
  location: { startLine: 12, endLine: 18 },
};

describe("extractResultMetadata — capture-sources platform and native gating", () => {
  it("guarantee-5: never surfaces a storybook URL for a native row, even one carrying a legacy storybook_url", () => {
    const meta = extractResultMetadata({ ...nativeJsonContent, storybook_url: "https://view.scrymore.com/should-not-appear" });
    expect(meta.storybookUrl).toBeUndefined();
  });

  it("labels the platform as 'React Native · iOS' / 'React Native · Android'", () => {
    expect(extractResultMetadata(nativeJsonContent).platformLabel).toBe("React Native · iOS");
    expect(extractResultMetadata({ ...nativeJsonContent, platform: "android" }).platformLabel).toBe(
      "React Native · Android",
    );
  });

  it("appends the code location's start line to the source path", () => {
    const meta = extractResultMetadata(nativeJsonContent);
    expect(meta.sourcePath).toBe("src/components/Button.tsx");
    expect(meta.sourceLine).toBe(12);
  });

  it("has no platformLabel and the legacy storybookUrl fallback for the web default (absent source_type)", () => {
    const meta = extractResultMetadata({
      filepath: "src/components/Button.stories.tsx",
      storybook_url: "https://view.scrymore.com/proj/1/iframe.html?id=button--primary",
    });
    expect(meta.platformLabel).toBeUndefined();
    expect(meta.storybookUrl).toBe("https://view.scrymore.com/proj/1/iframe.html?id=button--primary");
  });

  it("has no platformLabel for source_type 'storybook' (explicit legacy) either", () => {
    expect(extractResultMetadata({ source_type: "storybook" }).platformLabel).toBeUndefined();
  });

  // contract §8: an explicit live link always wins, including for a native
  // row (an on-device Storybook the customer also exposed over the network).
  it("uses links.live over the native gate", () => {
    const meta = extractResultMetadata({
      ...nativeJsonContent,
      links: { live: "https://device.example.com/iframe.html?id=ui-button--primary" },
    });
    expect(meta.storybookUrl).toBe("https://device.example.com/iframe.html?id=ui-button--primary");
  });

  it("isNativeSourceType / nativePlatformLabel: unrecognised source_type has no label but is not itself gated by these helpers as native", () => {
    expect(isNativeSourceType("some-future-kind")).toBe(false);
    expect(nativePlatformLabel("some-future-kind", "ios")).toBeUndefined();
    expect(isNativeSourceType(undefined)).toBe(false);
    expect(isNativeSourceType("storybook")).toBe(false);
  });
});

/**
 * Guarantee-6 flavour (feature flutter-capture, ledger F33): the label table is keyed by the kinds the SCF
 * spec registers, so every registered native kind must read as a labelled native source. This list mirrors the
 * native kinds of the `kind` enum in scry-capture-format schema/scf-1.0.json; add a kind there and here together.
 */
describe("native kind labels match the registered SCF kinds", () => {
  const registeredNativeKinds: Array<[string, string]> = [
    ["storybook-rn", "React Native"],
    ["swiftui-preview", "SwiftUI"],
    ["compose-preview", "Compose"],
    ["flutter-golden", "Flutter"],
    ["widgetbook", "Widgetbook"],
    ["uikit", "UIKit"],
  ];

  it.each(registeredNativeKinds)("%s has a label and counts as native", (kind, label) => {
    expect(isNativeSourceType(kind)).toBe(true);
    expect(nativePlatformLabel(kind, undefined)).toBe(label);
  });

  it("shows the platform for Flutter, SwiftUI and Compose builds", () => {
    expect(nativePlatformLabel("flutter-golden", "android")).toBe("Flutter · Android");
    expect(nativePlatformLabel("flutter-golden", "ios")).toBe("Flutter · iOS");
    expect(nativePlatformLabel("flutter-golden", "other")).toBe("Flutter · Other");
    expect(nativePlatformLabel("swiftui-preview", "ios")).toBe("SwiftUI · iOS");
    expect(nativePlatformLabel("compose-preview", "android")).toBe("Compose · Android");
  });

  it("keeps the legacy aliases", () => {
    expect(nativePlatformLabel("rn", "ios")).toBe("React Native · iOS");
    expect(nativePlatformLabel("swiftui", "ios")).toBe("SwiftUI · iOS");
    expect(nativePlatformLabel("compose", "android")).toBe("Compose · Android");
    expect(nativePlatformLabel("flutter", "android")).toBe("Flutter · Android");
  });

  it("leaves web and unregistered kinds unlabelled", () => {
    for (const kind of [undefined, "storybook", "playwright", "x-adobe-bridge", "x-flutter"]) {
      expect(isNativeSourceType(kind)).toBe(false);
      expect(nativePlatformLabel(kind, "android")).toBeUndefined();
    }
  });

  it("extractResultMetadata labels a flutter-golden row", () => {
    const meta = extractResultMetadata({ source_type: "flutter-golden", platform: "android" });
    expect(meta.platformLabel).toBe("Flutter · Android");
  });
});
