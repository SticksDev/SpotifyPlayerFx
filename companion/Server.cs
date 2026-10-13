using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlayerFxCompanion;

internal static partial class Program
{
    // Samples per frame: enough for a 512-sample FFT and a 320-column scope
    // reading every seventh sample (2240), with a little to spare.
    const int Window = 2304;
    const int FramesPerSecond = 60;
    const int MaxRequestBytes = 64 * 1024;

    static readonly List<Client> clients = new();
    static readonly object clientsLock = new();

    sealed class Client(Socket socket)
    {
        public readonly Socket Socket = socket;
        public volatile bool Closed;
        public int Sending;
    }

    sealed record Request(string Method, string Path, string Query, Dictionary<string, string> Headers, string Body)
    {
        public string? Header(string name) => Headers.GetValueOrDefault(name);
    }

    static async Task ServeAsync(CancellationToken ct)
    {
        var listener = new TcpListener(IPAddress.Loopback, settings.port);
        try
        {
            listener.Start();
        }
        catch (Exception ex)
        {
            Log($"could not listen on port {settings.port}: {ex.Message}");
            return;
        }
        Log($"listening on 127.0.0.1:{settings.port}");
        ct.Register(listener.Stop);
        while (!ct.IsCancellationRequested)
        {
            Socket s;
            try { s = await listener.AcceptSocketAsync(ct); }
            catch { break; }
            _ = Task.Run(() => HandleAsync(s, ct), ct);
        }
    }

    static async Task HandleAsync(Socket s, CancellationToken ct)
    {
        s.NoDelay = true;
        try
        {
            var req = await ReadRequestAsync(s, ct);
            if (req == null)
            {
                s.Dispose();
                return;
            }
            var origin = req.Header("Origin");
            if (!IsAllowed(req.Header("Host"), origin))
            {
                Log($"refused {req.Method} {req.Path} from origin {origin ?? "(none)"}, host {req.Header("Host") ?? "(none)"}");
                await RespondAsync(s, 403, "text/plain", "forbidden", null, ct);
                return;
            }
            if (req.Header("Upgrade")?.Equals("websocket", StringComparison.OrdinalIgnoreCase) == true)
            {
                await HandleWebSocketAsync(s, req.Header("Sec-WebSocket-Key") ?? "", ct);
                return;
            }
            await HandleHttpAsync(s, req, origin, ct);
        }
        catch (Exception ex)
        {
            Log("request failed: " + ex.Message);
            try { s.Dispose(); } catch { }
        }
    }

    // Browsers send Origin on cross-origin fetches and every WebSocket, so
    // checking it keeps other websites from driving the API or reading the
    // audio. Requests with no Origin come from local programs (the installer).
    // The Host check stops DNS rebinding.
    static bool IsAllowed(string? host, string? origin)
    {
        if (host != $"127.0.0.1:{settings.port}" && host != $"localhost:{settings.port}") return false;
        return origin == null || settings.allowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);
    }

    static async Task<Request?> ReadRequestAsync(Socket s, CancellationToken ct)
    {
        var data = new MemoryStream();
        var buf = new byte[4096];
        int headerEnd;
        while ((headerEnd = data.GetBuffer().AsSpan(0, (int)data.Length).IndexOf("\r\n\r\n"u8)) < 0)
        {
            if (data.Length >= MaxRequestBytes) return null;
            int n = await s.ReceiveAsync(buf, SocketFlags.None, ct);
            if (n <= 0) return null;
            data.Write(buf, 0, n);
        }

        var lines = Encoding.ASCII.GetString(data.GetBuffer(), 0, headerEnd).Split("\r\n");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            int colon = line.IndexOf(':');
            if (colon > 0) headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }

        int bodyStart = headerEnd + 4;
        int length = int.TryParse(headers.GetValueOrDefault("Content-Length"), out var cl) ? Math.Clamp(cl, 0, MaxRequestBytes) : 0;
        while (data.Length - bodyStart < length)
        {
            int n = await s.ReceiveAsync(buf, SocketFlags.None, ct);
            if (n <= 0) break;
            data.Write(buf, 0, n);
        }
        var body = Encoding.UTF8.GetString(data.GetBuffer(), bodyStart, (int)Math.Min(length, data.Length - bodyStart));

        var start = lines[0].Split(' ');
        var target = start.Length > 1 ? start[1] : "/";
        int q = target.IndexOf('?');
        return new Request(start[0], q < 0 ? target : target[..q], q < 0 ? "" : target[(q + 1)..], headers, body);
    }

    static async Task HandleHttpAsync(Socket s, Request req, string? origin, CancellationToken ct)
    {
        var remote = s.RemoteEndPoint?.ToString() ?? "?";
        if (req.Method != "GET" && req.Method != "OPTIONS") Log($"{req.Method} {req.Path} from {remote}");
        if (req.Method == "OPTIONS")
        {
            await RespondAsync(s, 204, "text/plain", "", origin, ct);
            return;
        }

        int status = 200;
        string contentType = "application/json";
        string payload;
        bool Enabled() => JsonNode.Parse(req.Body)?["enabled"]?.GetValue<bool>() ?? true;
        try
        {
            switch (req.Method, req.Path)
            {
                case ("GET", "/"):
                    contentType = "text/plain";
                    payload = $"Player FX companion {Version()}. WebSocket for audio, GET /status for control.";
                    break;
                case ("GET", "/status"):
                    payload = StatusJson();
                    break;
                case ("POST", "/capture"):
                    captureEnabled = settings.captureEnabled = Enabled();
                    SaveSettings();
                    Log($"capture {(captureEnabled ? "enabled" : "disabled")} from the page");
                    payload = StatusJson();
                    break;
                case ("POST", "/startup"):
                    {
                        var on = Enabled();
                        SetStartup(on);
                        Log($"run at sign-in {(on ? "on" : "off")}");
                        payload = StatusJson();
                        break;
                    }
                case ("POST", "/autogain"):
                    autoGain = settings.autoGain = Enabled();
                    SaveSettings();
                    payload = StatusJson();
                    break;
                case ("GET", "/logs"):
                    {
                        int lines = 200;
                        foreach (var kv in req.Query.Split('&'))
                        {
                            if (kv.StartsWith("lines=")) int.TryParse(kv[6..], out lines);
                        }
                        contentType = "text/plain; charset=utf-8";
                        payload = LogTail(Math.Clamp(lines, 1, 2000));
                        break;
                    }
                case ("GET", "/update/check"):
                    payload = await CheckUpdateJsonAsync();
                    break;
                case ("POST", "/update"):
                    payload = await StartUpdateAsync();
                    break;
                case ("POST", "/quit"):
                    payload = "{\"ok\":true}";
                    _ = Task.Run(async () =>
                    {
                        await Task.Delay(300); // let the response go out first
                        Quit("POST /quit from " + remote);
                    });
                    break;
                case ("POST", "/uninstall"):
                    payload = "{\"ok\":true}";
                    _ = Task.Run(async () =>
                    {
                        await Task.Delay(300);
                        Log("uninstalling from the page");
                        try { SetStartup(false); } catch { }
                        ScheduleDirectoryRemoval();
                        Quit("POST /uninstall from " + remote);
                    });
                    break;
                default:
                    status = 404;
                    payload = "{\"error\":\"not found\"}";
                    break;
            }
        }
        catch (Exception ex)
        {
            status = 500;
            payload = JsonSerializer.Serialize(new { error = ex.Message });
        }
        await RespondAsync(s, status, contentType, payload, origin, ct);
    }

    static async Task RespondAsync(Socket s, int status, string contentType, string payload, string? origin, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(payload);
        var reason = status switch { 204 => "No Content", 403 => "Forbidden", 404 => "Not Found", 500 => "Internal Server Error", _ => "OK" };
        var header = new StringBuilder()
            .Append($"HTTP/1.1 {status} {reason}\r\n")
            .Append($"Content-Type: {contentType}\r\n")
            .Append($"Content-Length: {bytes.Length}\r\n");
        if (origin != null)
        {
            header.Append($"Access-Control-Allow-Origin: {origin}\r\n")
                .Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
                .Append("Access-Control-Allow-Headers: Content-Type\r\n")
                .Append("Vary: Origin\r\n");
        }
        header.Append("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        try
        {
            await s.SendAsync(Encoding.ASCII.GetBytes(header.ToString()), SocketFlags.None, ct);
            if (bytes.Length > 0) await s.SendAsync(bytes, SocketFlags.None, ct);
            s.Shutdown(SocketShutdown.Both);
        }
        catch { } // the client went away
        finally
        {
            s.Dispose();
        }
    }

    static string StatusJson()
    {
        int clientCount;
        lock (clientsLock) clientCount = clients.Count;
        return JsonSerializer.Serialize(new
        {
            app = "playerfx-companion",
            version = Version(),
            pid = Environment.ProcessId,
            uptimeSeconds = (int)(DateTime.UtcNow - startedAt).TotalSeconds,
            port = settings.port,
            capturing,
            captureEnabled,
            spotify = spotifyPid != 0,
            spotifyPid,
            startup = StartupEnabled(),
            autoGain,
            clients = clientCount,
            installDir = InstallDir,
            logPath,
            repo = Repo,
            updateState,
        });
    }

    // A minimal RFC 6455 server: it only sends, and reads just enough to
    // honour close and ping.
    static async Task HandleWebSocketAsync(Socket s, string key, CancellationToken ct)
    {
        var client = new Client(s);
        try
        {
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await s.SendAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"), SocketFlags.None, ct);

            int count;
            lock (clientsLock) { clients.Add(client); count = clients.Count; }
            Log($"audio client connected ({count})");
            SendText(client, $"{{\"type\":\"hello\",\"rate\":{SampleRate},\"window\":{Window},\"spotify\":{(spotifyPid != 0 ? "true" : "false")},\"version\":\"{Version()}\"}}");

            var buf = new byte[4096];
            while (!ct.IsCancellationRequested && !client.Closed)
            {
                int n = await s.ReceiveAsync(buf, SocketFlags.None, ct);
                if (n <= 0) break;
                int opcode = buf[0] & 0x0F;
                if (opcode == 8) break;
                if (opcode == 9) SendFrame(client, 0x8A, [], 0);
            }
        }
        catch { } // disconnected
        finally
        {
            client.Closed = true;
            int count;
            lock (clientsLock) { clients.Remove(client); count = clients.Count; }
            try { s.Shutdown(SocketShutdown.Both); } catch { }
            s.Dispose();
            Log($"audio client disconnected ({count})");
        }
    }

    static void SendText(Client c, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        SendFrame(c, 0x81, bytes, bytes.Length);
    }

    static void SendFrame(Client c, byte first, byte[] payload, int length)
    {
        if (c.Closed) return;
        // Drop the frame if the previous one is still going out; the next
        // window supersedes it anyway.
        if (Interlocked.CompareExchange(ref c.Sending, 1, 0) != 0) return;
        try
        {
            if (length > ushort.MaxValue) throw new ArgumentOutOfRangeException(nameof(length));
            int headerSize = length < 126 ? 2 : 4;
            var frame = new byte[headerSize + length];
            frame[0] = first;
            if (length < 126)
            {
                frame[1] = (byte)length;
            }
            else
            {
                frame[1] = 126;
                frame[2] = (byte)(length >> 8);
                frame[3] = (byte)length;
            }
            Buffer.BlockCopy(payload, 0, frame, headerSize, length);
            c.Socket.Send(frame);
        }
        catch
        {
            c.Closed = true;
        }
        finally
        {
            Interlocked.Exchange(ref c.Sending, 0);
        }
    }

    static void BroadcastLoop(CancellationToken ct)
    {
        var window = new float[Window];
        var payload = new byte[Window * 2];
        var period = TimeSpan.FromSeconds(1.0 / FramesPerSecond);
        var next = DateTime.UtcNow;
        bool? lastCapturing = null;
        while (!ct.IsCancellationRequested)
        {
            next += period;
            var wait = next - DateTime.UtcNow;
            if (wait > TimeSpan.Zero) Thread.Sleep(wait);
            else next = DateTime.UtcNow;

            Client[] targets;
            lock (clientsLock) targets = clients.ToArray();
            if (targets.Length == 0) continue;

            bool now = capturing;
            if (now != lastCapturing)
            {
                lastCapturing = now;
                foreach (var c in targets) SendText(c, $"{{\"type\":\"status\",\"spotify\":{(now ? "true" : "false")}}}");
            }
            if (!now) continue;

            ring.Latest(window, Window);
            for (int i = 0; i < Window; i++)
            {
                short v = (short)Math.Clamp(window[i] * 32767f, -32768f, 32767f);
                payload[2 * i] = (byte)v;
                payload[2 * i + 1] = (byte)(v >> 8);
            }
            foreach (var c in targets) SendFrame(c, 0x82, payload, payload.Length);
        }
    }
}
