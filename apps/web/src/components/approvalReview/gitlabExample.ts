import { parseApprovalReviewDetail } from "@t3tools/client-runtime/approvalReview";

import metadata from "./fixtures/gitlab/bundle.metadata.json" with { type: "json" };
import original0 from "./fixtures/gitlab/NOTES.txt?raw";
import original1 from "./fixtures/gitlab/change.example.json?raw";
import original2 from "./fixtures/gitlab/gitlab.after.container?raw";
import original3 from "./fixtures/gitlab/gitlab.before.container?raw";
import original4 from "./fixtures/gitlab/request.example.json?raw";
import original5 from "./fixtures/gitlab/review.json?raw";
import original6 from "./fixtures/gitlab/review.py?raw";
import original7 from "./fixtures/gitlab/upgrade.py?raw";

const originals: Readonly<Record<string, string>> = {
  "NOTES.txt": original0,
  "change.example.json": original1,
  "gitlab.after.container": original2,
  "gitlab.before.container": original3,
  "request.example.json": original4,
  "review.json": original5,
  "review.py": original6,
  "upgrade.py": original7,
};

// Metadata is derived offline from AST only; all eight originals remain byte-for-byte intact.
const parsed = parseApprovalReviewDetail({
  approvalReview: {
    ...metadata,
    files: metadata.files.map((file) => ({ ...file, content: originals[file.path] })),
  },
});
if (parsed.kind !== "bundle") throw new Error("Invalid bundled GitLab example");

export const gitlabExampleBundle = parsed.bundle;
