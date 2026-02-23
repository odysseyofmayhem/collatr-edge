// CollatrEdge — version command
// PRD refs: §18 Deployment & Distribution

import packageJson from "../../../package.json";

/**
 * Print version and build info to stdout.
 * Returns exit code 0.
 */
export function versionCommand(): number {
  const version = packageJson.version;
  const runtime = `Bun ${Bun.version}`;
  const platform = `${process.platform}-${process.arch}`;
  const buildTime = Bun.env.BUILD_TIME || new Date().toISOString();

  process.stdout.write(
    `CollatrEdge v${version}\nRuntime: ${runtime}\nPlatform: ${platform}\nBuild: ${buildTime}\n`,
  );

  return 0;
}
