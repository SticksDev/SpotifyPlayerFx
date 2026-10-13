using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlayerFxCompanion;

internal static partial class Program
{
    const string ReleaseAsset = "PlayerFxCompanion.exe";

    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(30) };
    static string? updateState; // null, "downloading", "restarting", or "error: ..."

    static async Task<(string latest, string? url, string? notes)> FetchLatestAsync()
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repo}/releases/latest");
        req.Headers.UserAgent.ParseAdd("PlayerFxCompanion/" + Version());
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var res = await http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync());
        var latest = (json?["tag_name"]?.GetValue<string>() ?? "").TrimStart('v', 'V');
        var url = json?["assets"]?.AsArray()
            .FirstOrDefault(a => string.Equals(a?["name"]?.GetValue<string>(), ReleaseAsset, StringComparison.OrdinalIgnoreCase))
            ?["browser_download_url"]?.GetValue<string>();
        return (latest, url, json?["body"]?.GetValue<string>());
    }

    static bool IsNewer(string latest, string current) =>
        System.Version.TryParse(latest, out var l) && System.Version.TryParse(current, out var c) && l > c;

    static async Task<string> CheckUpdateJsonAsync()
    {
        try
        {
            var (latest, url, notes) = await FetchLatestAsync();
            return JsonSerializer.Serialize(new
            {
                current = Version(),
                latest,
                available = IsNewer(latest, Version()) && url != null,
                url,
                notes = notes?.Length > 1500 ? notes[..1500] : notes,
                repo = Repo,
            });
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { current = Version(), error = ex.Message, repo = Repo });
        }
    }

    static async Task<string> StartUpdateAsync()
    {
        if (updateState is "downloading" or "restarting")
        {
            return JsonSerializer.Serialize(new { started = false, updateState });
        }
        try
        {
            var (latest, url, _) = await FetchLatestAsync();
            if (!IsNewer(latest, Version()) || url == null)
            {
                return JsonSerializer.Serialize(new { started = false, current = Version(), latest, reason = "already up to date" });
            }
            updateState = "downloading";
            Log($"updating {Version()} -> {latest} from {url}");
            _ = Task.Run(() => DownloadAndRestartAsync(latest, url));
            return JsonSerializer.Serialize(new { started = true, current = Version(), latest });
        }
        catch (Exception ex)
        {
            updateState = "error: " + ex.Message;
            return JsonSerializer.Serialize(new { started = false, error = ex.Message });
        }
    }

    static async Task DownloadAndRestartAsync(string latest, string url)
    {
        try
        {
            var dir = Path.Combine(InstallDir, "update");
            Directory.CreateDirectory(dir);
            var tmp = Path.Combine(dir, ReleaseAsset);
            using (var res = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
            {
                res.EnsureSuccessStatusCode();
                await using var fs = File.Create(tmp);
                await res.Content.CopyToAsync(fs);
            }
            updateState = "restarting";
            Log("download complete; swapping in and restarting");
            // The running exe can't be replaced, so a detached shell waits for
            // this process to exit, swaps the file and starts the new one.
            int pid = Environment.ProcessId;
            var script =
                "/c ping 127.0.0.1 -n 2 >nul & " +
                $":wait & tasklist /FI \"PID eq {pid}\" | find \"{pid}\" >nul && (ping 127.0.0.1 -n 2 >nul & goto wait) & " +
                $"copy /y \"{tmp}\" \"{InstalledExe}\" >nul & del /q \"{tmp}\" & start \"\" \"{InstalledExe}\" --resident";
            Process.Start(new ProcessStartInfo("cmd.exe", script) { UseShellExecute = false, CreateNoWindow = true });
            await Task.Delay(500);
            Quit("restarting for update to " + latest);
        }
        catch (Exception ex)
        {
            updateState = "error: " + ex.Message;
            Log("update failed: " + ex.Message);
        }
    }
}
