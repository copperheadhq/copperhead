/**
 * Load the real TypeScript CLI in the current Node process without the tsx
 * command's watch/IPC wrapper. Keep Node 20.0-20.5 supported by using the
 * legacy loader flag documented at https://tsx.is/dev-api/node-cli.
 */
export function cliProcessArgs(args: string[], nodeVersion = process.versions.node): string[] {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const supportsImport = major > 20 || (major === 20 && minor >= 6) || (major === 18 && minor >= 19);
  return [supportsImport ? '--import' : '--loader', 'tsx', 'src/cli.ts', ...args];
}
