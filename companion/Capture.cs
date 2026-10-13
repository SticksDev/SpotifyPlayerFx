using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wasapi.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace PlayerFxCompanion;

internal static partial class Program
{
    const int SampleRate = 44100;
    // Half a second of mono audio kept, as spotifast's tap.
    const int Kept = SampleRate / 2;

    static readonly Ring ring = new(Kept);
    static volatile bool autoGain = true;
    static volatile bool captureEnabled = true;
    static volatile bool capturing;
    static volatile int spotifyPid;

    static void CaptureLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var spotify = captureEnabled ? FindSpotify() : null;
            if (spotify == null)
            {
                spotifyPid = 0;
                ring.Clear();
                Thread.Sleep(2000);
                continue;
            }
            spotifyPid = spotify.Id;
            Log($"Spotify found, pid {spotify.Id}; starting capture");
            try
            {
                Capture(spotify, ct);
            }
            catch (Exception ex)
            {
                Log($"capture failed: {ex.Message}");
                Thread.Sleep(3000);
            }
            finally
            {
                capturing = false;
                ring.Clear();
            }
        }
    }

    // The Spotify process that owns the window; its process tree includes
    // the one that renders audio.
    static Process? FindSpotify()
    {
        foreach (var p in Process.GetProcessesByName("Spotify"))
        {
            try
            {
                if (p.MainWindowHandle != IntPtr.Zero) return p;
            }
            catch { } // exited while we looked
        }
        return null;
    }

    static void Capture(Process spotify, CancellationToken ct)
    {
        using var client = ActivateProcessLoopback((uint)spotify.Id);
        var format = new WaveFormat(SampleRate, 16, 2);
        var flags = AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback;
        // 200 ms buffer, in 100-nanosecond units.
        client.Initialize(AudioClientShareMode.Shared, flags, 2_000_000, 0, format, Guid.Empty);
        using var ready = new AutoResetEvent(false);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        var capture = client.AudioCaptureClient;
        client.Start();
        capturing = true;
        Log("capture running (44.1 kHz, stereo 16-bit -> mono)");

        var gain = new AutoGain();
        float[] mono = new float[4096];
        while (!ct.IsCancellationRequested && captureEnabled && !spotify.HasExited)
        {
            ready.WaitOne(100);
            while (capture.GetNextPacketSize() > 0)
            {
                var buffer = capture.GetBuffer(out int count, out AudioClientBufferFlags bufferFlags);
                if (count > 0)
                {
                    if (mono.Length < count) mono = new float[count];
                    if ((bufferFlags & AudioClientBufferFlags.Silent) != 0)
                    {
                        Array.Clear(mono, 0, count);
                    }
                    else
                    {
                        unsafe
                        {
                            short* s = (short*)buffer;
                            for (int i = 0; i < count; i++) mono[i] = (s[2 * i] + s[2 * i + 1]) * (0.5f / 32768f);
                        }
                        if (autoGain) gain.Apply(mono, count);
                    }
                    ring.Push(mono, count);
                }
                capture.ReleaseBuffer(count);
            }
        }
        client.Stop();
        capturing = false;
        Log(spotify.HasExited ? "Spotify closed; capture stopped" : captureEnabled ? "capture stopped" : "capture turned off");
    }

    // Process loopback isn't wrapped by NAudio, so the activation is done by hand.
    const string VirtualLoopbackDevice = "VAD\\Process_Loopback";
    const int ActivationTypeProcessLoopback = 1;
    const int LoopbackModeIncludeTargetProcessTree = 0;
    const ushort VtBlob = 0x41;

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessLoopbackParams
    {
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ActivationParams
    {
        public int ActivationType;
        public ProcessLoopbackParams ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariantBlob
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public uint cbSize;
        public IntPtr pBlobData;
    }

    // The completion handler must be agile or activation fails.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEventSlim Done = new();
        public int Hr;
        public object? Unknown;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                op.GetActivateResult(out Hr, out Unknown);
            }
            catch (Exception ex)
            {
                Hr = ex.HResult;
            }
            Done.Set();
        }
    }

    static AudioClient ActivateProcessLoopback(uint pid)
    {
        var p = new ActivationParams
        {
            ActivationType = ActivationTypeProcessLoopback,
            ProcessLoopbackParams = new ProcessLoopbackParams
            {
                TargetProcessId = pid,
                ProcessLoopbackMode = LoopbackModeIncludeTargetProcessTree,
            },
        };
        int size = Marshal.SizeOf<ActivationParams>();
        IntPtr blob = Marshal.AllocHGlobal(size);
        IntPtr pv = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariantBlob>());
        try
        {
            Marshal.StructureToPtr(p, blob, false);
            Marshal.StructureToPtr(new PropVariantBlob { vt = VtBlob, cbSize = (uint)size, pBlobData = blob }, pv, false);

            var handler = new CompletionHandler();
            var iid = typeof(IAudioClient).GUID;
            ActivateAudioInterfaceAsync(VirtualLoopbackDevice, ref iid, pv, handler, out var op);
            if (!handler.Done.Wait(5000)) throw new TimeoutException("audio interface activation timed out");
            GC.KeepAlive(op);
            if (handler.Hr != 0) Marshal.ThrowExceptionForHR(handler.Hr);
            if (handler.Unknown is not IAudioClient iac) throw new InvalidOperationException("activation returned no IAudioClient");
            return new AudioClient(iac);
        }
        finally
        {
            Marshal.FreeHGlobal(pv);
            Marshal.FreeHGlobal(blob);
        }
    }

    // Spotify's volume slider scales what it renders, so a slow automatic
    // gain brings quiet settings back up for the analyser.
    sealed class AutoGain
    {
        float peak = 0.001f;
        float gain = 1f;

        public void Apply(float[] buf, int count)
        {
            float p = 0;
            for (int i = 0; i < count; i++) p = Math.Max(p, Math.Abs(buf[i]));
            // Fast up, slow down (about three seconds), so a drop in volume
            // is followed but a loud hit isn't squashed.
            peak = p > peak ? p : peak * 0.995f + p * 0.005f;
            float target = peak > 0.02f ? Math.Clamp(0.7f / peak, 1f, 8f) : gain;
            gain += (target - gain) * 0.02f;
            if (Math.Abs(gain - 1f) < 0.01f) return;
            for (int i = 0; i < count; i++) buf[i] = Math.Clamp(buf[i] * gain, -1f, 1f);
        }
    }

    sealed class Ring(int size)
    {
        readonly float[] data = new float[size];
        readonly object sync = new();
        int head;
        int count;

        public void Push(float[] src, int n)
        {
            lock (sync)
            {
                for (int i = 0; i < n; i++)
                {
                    data[head] = src[i];
                    head = (head + 1) % data.Length;
                }
                count = Math.Min(count + n, data.Length);
            }
        }

        public void Clear()
        {
            lock (sync) { head = 0; count = 0; }
        }

        // The newest `n` samples into `dst`, silence where there are fewer.
        public void Latest(float[] dst, int n)
        {
            lock (sync)
            {
                int take = Math.Min(n, count);
                Array.Clear(dst, 0, n - take);
                int start = (head - take + data.Length) % data.Length;
                for (int i = 0; i < take; i++) dst[n - take + i] = data[(start + i) % data.Length];
            }
        }
    }
}
