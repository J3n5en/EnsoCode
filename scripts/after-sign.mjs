import path from 'node:path';
import { notarizeApp, notaryCredentials, shouldNotarize } from '../src/tooling/notarizeApp.mjs';

export default async function afterSign(context) {
  if (!shouldNotarize(context)) return;
  const creds = notaryCredentials(process.env);
  if (!creds) {
    console.warn(
      '  • skipped notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set'
    );
    return;
  }
  const app = `${context.packager.appInfo.productFilename}.app`;
  await notarizeApp(path.join(context.appOutDir, app), creds);
}
