import { describe, it, expect } from "vitest";
import { formatIssue } from "../src/issues/format";

/**
 * feature capture-sources, guarantee-5: the issue tools' "Code" block never
 * offers a Storybook link for a row with no live Storybook.
 *
 * The dashboard's issue payload (lib/agent/issue-payload.ts, a later PR) does
 * not send `code.source_type` / `code.platform` yet, so every fixture without
 * them below is what every payload looks like today — the gate must leave
 * that behaviour byte-identical (G1).
 */
function baseData(code: Record<string, unknown>) {
  return {
    issue: { number: 7, id: "issue_1", status: "open", severity: "minor", fix_side: "code" },
    project_id: "proj-1",
    link_id: "link-1",
    resolution: [],
    code,
  };
}

describe("formatIssue — Code block platform gating (capture-sources)", () => {
  it("guarantee-1: keeps 'Code (Storybook):' and the storybook_url line when the payload has no source_type (today's shape)", () => {
    const text = formatIssue(baseData({
      story_id: "button--primary",
      story_file: "Button.stories.tsx",
      storybook_url: "https://view.scrymore.com/proj/1/iframe.html?id=button--primary",
    }));
    expect(text).toContain("Code (Storybook):");
    expect(text).toContain("https://view.scrymore.com/proj/1/iframe.html?id=button--primary");
  });

  it("guarantee-5: drops the storybook_url line and the '(Storybook)' header for a native row, even if storybook_url is still sent", () => {
    const text = formatIssue(baseData({
      source_type: "storybook-rn",
      platform: "ios",
      story_id: "button--primary",
      story_file: "Button.stories.tsx",
      storybook_url: "https://should-not-appear.example.com",
    }));
    expect(text).toContain("Code (React Native · iOS):");
    expect(text).not.toContain("Code (Storybook):");
    expect(text).not.toContain("should-not-appear");
  });

  it("labels Android the same way", () => {
    const text = formatIssue(baseData({ source_type: "storybook-rn", platform: "android" }));
    expect(text).toContain("Code (React Native · Android):");
  });

  it("falls back to 'Code (Storybook):' for an explicit source_type of 'storybook'", () => {
    const text = formatIssue(baseData({ source_type: "storybook", storybook_url: "https://view.scrymore.com/x" }));
    expect(text).toContain("Code (Storybook):");
    expect(text).toContain("https://view.scrymore.com/x");
  });

  it("still prints component_file/story_file/repository/build lines for a native row", () => {
    const text = formatIssue(baseData({
      source_type: "storybook-rn",
      platform: "ios",
      component_file: "src/components/Button.tsx",
      story_file: "src/components/Button.stories.tsx",
      repository: "epinnock/kettle",
      build_id: "b_1234",
      build_sha: "abc1234",
    }));
    expect(text).toContain("component_file src/components/Button.tsx");
    expect(text).toContain("story_file src/components/Button.stories.tsx");
    expect(text).toContain("repository epinnock/kettle");
    expect(text).toContain("build b_1234 · sha abc1234");
  });
});
