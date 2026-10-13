// Player FX companion: captures only Spotify's audio through WASAPI process
// loopback and streams it to the Spicetify extension over a WebSocket on
// 127.0.0.1. The same port serves the small HTTP API the Player FX page uses
// to manage it. The command line and API are described in README.md.
//
// Capture.cs  WASAPI capture, gain, ring buffer
// Server.cs   HTTP control API and the audio WebSocket
// Updater.cs  updates from GitHub releases

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

namespace PlayerFxCompanion;

internal static partial class Program
{
    const string AppName = "PlayerFxCompanion";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string MutexName = "Global\\PlayerFxCompanion";
    // Keep in sync with REPO in src/app/companion.tsx.
    const string DefaultRepo = "SticksDev/SpotifyPlayerFx";
    const int DefaultPort = 47631;
    const long LogRotateBytes = 1024 * 1024;

    static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PlayerFX");
    static readonly string InstalledExe = Path.Combine(InstallDir, AppName + ".exe");
    static readonly string SettingsPath = Path.Combine(InstallDir, "settings.json");
    static string logPath = Path.Combine(InstallDir, "logs", "companion.log");
    static readonly object logLock = new();

    static readonly DateTime startedAt = DateTime.UtcNow;
    static readonly CancellationTokenSource cts = new();
    static Settings settings = new();
    static volatile bool quitting;

    sealed class Settings
    {
        public int port { get; set; } = DefaultPort;
        public bool captureEnabled { get; set; } = true;
        public bool autoGain { get; set; } = true;
        // Only set by --repo; otherwise installs follow DefaultRepo.
        public string? repo { get; set; }
        // Pages allowed to use the API. Spotify's renderer by default; edit
        // settings.json if a Spotify update moves it.
        public string[] allowedOrigins { get; set; } = ["https://xpui.app.spotify.com"];
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr h, string text, string caption, uint type);
    static void Say(string text) => MessageBoxW(IntPtr.Zero, text, "Player FX companion", 0x40);

    static int Main(string[] args)
    {
        LoadSettings();
        string? mode = null;
        int after = 0;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--port" when i + 1 < args.Length && int.TryParse(args[++i], out var p): settings.port = p; break;
                case "--no-auto-gain": settings.autoGain = false; break;
                case "--log" when i + 1 < args.Length: logPath = args[++i]; break;
                case "--repo" when i + 1 < args.Length: settings.repo = args[++i]; break;
                case "--resident": mode = "resident"; break;
                case "--after" when i + 1 < args.Length && int.TryParse(args[++i], out var pid): after = pid; break;
                case "--install": mode = "install"; break;
                case "--uninstall": mode = "uninstall"; break;
                case "--version": Say($"Player FX companion {Version()}"); return 0;
                case "-h" or "--help":
                    Say("PlayerFxCompanion [--resident | --install | --uninstall | --version] [--port N] [--no-auto-gain] [--log PATH] [--repo OWNER/REPO]");
                    return 0;
            }
        }
        autoGain = settings.autoGain;
        captureEnabled = settings.captureEnabled;

        var here = Environment.ProcessPath ?? "";
        mode ??= IsInstalledCopy(here) ? "resident" : "install";
        if (mode == "install") return Install(here);
        if (mode == "uninstall") return Uninstall();

        // Started by the updater: let the old version exit and free the mutex.
        if (after != 0)
        {
            try { Process.GetProcessById(after).WaitForExit(10_000); }
            catch (ArgumentException) { } // already gone
        }

        using var mutex = new Mutex(true, MutexName, out bool first);
        if (!first)
        {
            Log("another instance is running; exiting");
            return 0;
        }
        try { File.Delete(InstalledExe + ".old"); } catch { } // left by the last update

        Log($"Player FX companion {Version()} starting (pid {Environment.ProcessId}, port {settings.port}, capture {(captureEnabled ? "on" : "off")})");
        new Thread(() => ServeAsync(cts.Token).GetAwaiter().GetResult()) { IsBackground = true, Name = "server" }.Start();
        new Thread(() => BroadcastLoop(cts.Token)) { IsBackground = true, Name = "send" }.Start();
        CaptureLoop(cts.Token);
        Log("exiting");
        return 0;
    }

    static string Repo => settings.repo ?? DefaultRepo;

    static bool IsInstalledCopy(string path) =>
        string.Equals(Path.GetFullPath(path), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase);

    static int Install(string here)
    {
        try
        {
            Directory.CreateDirectory(Path.Combine(InstallDir, "logs"));
            // A running copy holds the exe open; ask it to quit first.
            AskRunningToQuit();
            if (!IsInstalledCopy(here)) File.Copy(here, InstalledExe, true);
            SaveSettings();
            SetStartup(true);
            Process.Start(new ProcessStartInfo(InstalledExe, "--resident") { UseShellExecute = false, WorkingDirectory = InstallDir });
            Log($"installed {Version()} to {InstalledExe}");
            Say($"Player FX companion {Version()} is installed and running.\n\n" +
                "It starts when you sign in, stays idle until Spotify is open, and only captures Spotify's audio.\n\n" +
                $"Manage it in Spotify from the profile menu > Player FX.\n\nInstalled to {InstallDir}");
            return 0;
        }
        catch (Exception ex)
        {
            Say("Couldn't install the companion: " + ex.Message);
            return 1;
        }
    }

    static int Uninstall()
    {
        try
        {
            AskRunningToQuit();
            SetStartup(false);
            ScheduleDirectoryRemoval();
            Say("Player FX companion has been removed. You can turn off live audio on the Player FX page in Spotify.");
            return 0;
        }
        catch (Exception ex)
        {
            Say("Couldn't uninstall the companion: " + ex.Message);
            return 1;
        }
    }

    static void AskRunningToQuit()
    {
        try
        {
            using var c = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            c.PostAsync($"http://127.0.0.1:{settings.port}/quit", new StringContent("")).Wait();
        }
        catch { } // nothing running
        for (int i = 0; i < 30; i++)
        {
            try
            {
                using var m = new Mutex(true, MutexName, out bool first);
                if (first) return;
            }
            catch { }
            Thread.Sleep(100);
        }
    }

    // The directory can't be deleted while this exe runs from it, so a
    // detached shell does it once we've exited.
    static void ScheduleDirectoryRemoval()
    {
        var cmd = $"/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"{InstallDir}\"";
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { UseShellExecute = false, CreateNoWindow = true });
    }

    static void LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
                settings = JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsPath)) ?? new Settings();
        }
        catch
        {
            settings = new Settings();
        }
        if (settings.port < 1024 || settings.port > 65535) settings.port = DefaultPort;
        // Builds before 1.0 saved the default, including a placeholder, so treat that as unset.
        if (string.IsNullOrWhiteSpace(settings.repo) || settings.repo.StartsWith("OWNER/")) settings.repo = null;
        settings.allowedOrigins ??= new Settings().allowedOrigins;
    }

    static void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(InstallDir);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            }));
        }
        catch (Exception ex)
        {
            Log("could not save settings: " + ex.Message);
        }
    }

    static bool StartupEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, false);
            return key?.GetValue(AppName) is string;
        }
        catch
        {
            return false;
        }
    }

    static void SetStartup(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, true);
        if (on) key.SetValue(AppName, $"\"{InstalledExe}\" --resident");
        else key.DeleteValue(AppName, false);
    }

    static string Version()
    {
        var v = typeof(Program).Assembly.GetName().Version;
        return v == null ? "0.0.0" : $"{v.Major}.{v.Minor}.{v.Build}";
    }

    static void Quit(string reason)
    {
        if (quitting) return;
        quitting = true;
        Log("quit: " + reason);
        cts.Cancel();
        Environment.Exit(0);
    }

    static void Log(string s)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {s}";
        try { Console.WriteLine(line); } catch { }
        lock (logLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                var fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > LogRotateBytes) File.Move(logPath, logPath + ".1", true);
                File.AppendAllText(logPath, line + Environment.NewLine);
            }
            catch { } // logging must never take the capture down
        }
    }

    static string LogTail(int lines)
    {
        lock (logLock)
        {
            try
            {
                if (!File.Exists(logPath)) return "";
                var all = File.ReadAllLines(logPath);
                return string.Join("\n", all.Skip(Math.Max(0, all.Length - lines)));
            }
            catch (Exception ex)
            {
                return "could not read log: " + ex.Message;
            }
        }
    }
}
