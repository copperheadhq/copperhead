import fs from 'fs';
import path from 'path';

export interface Manifest {
  brief: string;
  createdAt: string;
  stages: string[];
  status: string;
}

/**
 * Write a JSON manifest file to the project root.
 * This file is used by the e2e test to confirm successful completion.
 */
export const writeManifest = (projectRoot: string, manifest: Manifest) => {
  const manifestPath = path.join(projectRoot, 'copperhead.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
};
