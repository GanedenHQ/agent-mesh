import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Native desktop notification + sound for incoming mesh messages.
 *
 * Why no `node-notifier`: it ships native helper binaries (terminal-notifier.app,
 * SnoreToast.exe) that it spawns from `node_modules`. The channel is distributed as
 * a `bun build --compile` single binary (and as a bundled `channel.js` in the plugin),
 * so those assets are NOT on disk at runtime and the notification silently fails.
 *
 * Instead we shell out to commands that ship with the OS itself and therefore survive
 * compilation: `afplay`/`osascript` (macOS), `powershell` (Windows), `notify-send`/
 * `paplay` (Linux). Everything is fire-and-forget and non-fatal — a failed notification
 * must never disturb the MCP transport.
 *
 * Untrusted text (message body, sender) is passed as argv, never interpolated into a
 * shell string, so a teammate's message content cannot inject commands.
 */

const OS = platform();

/**
 * Neutralize argv flag smuggling: a message body/sender starting with `-` would be
 * parsed as an option by osascript/notify-send. We pass `--` end-of-options markers
 * where supported, and additionally prefix a space so a leading dash can never be read
 * as a flag even by a tool that ignores `--`. The text is display-only, so a leading
 * space is harmless.
 */
function dashSafe(s: string): string {
  return s.startsWith('-') ? ' ' + s : s;
}

/** Run a command detached, ignoring all I/O and errors. Never throws. */
function fire(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: false });
    child.on('error', () => {
      /* command missing / blocked — non-fatal */
    });
  } catch {
    /* spawn threw synchronously — non-fatal */
  }
}

/** Play the notification sound. `soundName` is a macOS system sound (e.g. "Glass"). */
function playSound(soundName: string): void {
  if (OS === 'darwin') {
    fire('afplay', [`/System/Library/Sounds/${soundName}.aiff`]);
  } else if (OS === 'win32') {
    // SystemSounds is built into every Windows; reliable regardless of Focus Assist
    // for audio (the toast itself may be silenced, the ding generally is not).
    fire('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Media.SystemSounds]::Asterisk.Play()',
    ]);
  } else {
    // Linux: best-effort, both are optional. paplay (PulseAudio) then aplay (ALSA).
    fire('paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga']);
  }
}

/**
 * Show a visual notification. Title/body are passed as argv where the platform allows
 * it (macOS osascript `on run argv`, Windows via env vars) to avoid any escaping issues.
 */
function showNotification(title: string, body: string): void {
  if (OS === 'darwin') {
    // `on run argv` keeps title/body out of the script text → no escaping, no injection.
    fire('osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e',
      'end run',
      '--',
      dashSafe(body),
      dashSafe(title),
    ]);
  } else if (OS === 'win32') {
    // WinRT toast via Windows PowerShell 5.1 (powershell.exe is always present;
    // pwsh/PS7 WinRT projection is unreliable, so we target powershell.exe explicitly).
    // Title/body are read from env vars to avoid escaping inside the script string.
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$x = $t.GetElementsByTagName("text")',
      '$x.Item(0).AppendChild($t.CreateTextNode($env:MESH_TITLE)) | Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode($env:MESH_BODY)) | Out-Null',
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
      "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')",
      '$notifier.Show($toast)',
    ].join('; ');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        detached: false,
        env: { ...process.env, MESH_TITLE: title, MESH_BODY: body },
      });
      child.on('error', () => undefined);
    } catch {
      /* non-fatal */
    }
  } else {
    fire('notify-send', [
      '--app-name=agent-mesh',
      '--icon=mail-message-new',
      '--',
      dashSafe(title),
      dashSafe(body),
    ]);
  }
}

/**
 * Fire a native notification + sound for an incoming message.
 *
 * Controlled by env:
 *   - MESH_NOTIFY=0     → disable entirely (headless/CI/server sessions)
 *   - MESH_NOTIFY=sound → sound only, no visual banner
 *   - MESH_SOUND=Hero   → override the macOS system sound (default "Glass")
 *
 * ## Why `sound` exists
 *
 * On macOS the visual banner goes through `osascript -e 'display notification'`,
 * and that command belongs to no application: the OS attributes the banner to
 * Script Editor. It therefore shows the generic script icon, and clicking it
 * opens Automator instead of anything useful. `display notification` cannot
 * carry a custom icon nor name an app to activate — that is the ceiling of the
 * tool, not a missing option.
 *
 * The SOUND alone is still the cheapest "you have mail" signal for a terminal
 * session, hence a middle setting rather than an on/off switch.
 */
export function notify(title: string, body: string): void {
  const mode = process.env['MESH_NOTIFY'];
  if (mode === '0') return;
  const soundName = process.env['MESH_SOUND'] || 'Glass';
  if (mode !== 'sound') showNotification(title, body);
  playSound(soundName);
}
