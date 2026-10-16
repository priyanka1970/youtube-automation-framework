
import { chromium, type BrowserContext } from 'playwright';

// Always use installed Google Chrome for the persistent automation profile.
export async function launchProfile(
  profile: string
): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: false,
      acceptDownloads: true,
    });
  } catch (error: unknown) {
    const message = String(error);

    if (
      /profile.*in use|ProcessSingleton|Opening in existing browser session/i.test(
        message
      )
    ) {
      throw new Error(
        `Chrome is already using the automation profile "${profile}". ` +
        'Close the Chrome window using this profile before resuming.'
      );
    }

    if (
      /distribution.*not found|Executable doesn't exist|chrome.*not found/i.test(
        message
      )
    ) {
      throw new Error(
        'Installed Google Chrome could not be found. ' +
        'Install or update Chrome, then rerun the workflow.'
      );
    }

    throw error;
  }
}
