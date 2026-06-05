/**
 * CLI: mechanical tier-2 repository merge (upstream Ycode + MasjidWeb seams from main).
 */
import { join } from 'node:path';
import { reapplyTier2Seams } from '../lib/masjidweb/reapply-tier2-seams';

const REPO_ROOT = join(__dirname, '..');

function main(): void {
  reapplyTier2Seams({ repoRoot: REPO_ROOT });
  console.log('Tier-2 seam reapply complete.');
}

main();
