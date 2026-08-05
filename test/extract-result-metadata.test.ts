import { describe, it, expect } from "vitest";
import { extractResultMetadata } from "../src/utils/result-metadata";

/**
 * Records written by scry-build-processing-service (pipeline/vector-inserter.ts)
 * for a Storybook story. Field names here must stay in sync with that producer.
 */
const storybookJsonContent = {
  source_type: "storybook",
  filepath: "./src/components/PricingCard.tsx",
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
  it("surfaces the source path a coding agent needs to import the component", () => {
    const meta = extractResultMetadata(storybookJsonContent);
    expect(meta.sourcePath).toBe("./src/components/PricingCard.tsx");
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
