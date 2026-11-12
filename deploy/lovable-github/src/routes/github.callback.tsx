import { createFileRoute } from "@tanstack/react-router";
import { GitHubCallback } from "@/components/forge/GitHubCallback";

export const Route = createFileRoute("/github/callback")({
  head: () => ({
    meta: [
      { title: "Prepojenie GitHub – VORKEI" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: GitHubCallback,
});
