using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace QZZ.ServerControl;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var root = FindProjectRoot();
        if (root is null)
        {
            MessageBox.Show("未找到 server/index.js。请将控制器保留在项目目录内。", "QZZ 测试平台",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(root.ToUpperInvariant())))[..16];
        var startRequested = args.Contains("--start", StringComparer.OrdinalIgnoreCase);
        using var singleInstance = new Mutex(true, $"Local\\QZZ.ServerControl.{identity}", out var firstInstance);
        if (!firstInstance)
        {
            try
            {
                using var showExisting = EventWaitHandle.OpenExisting($"Local\\QZZ.ServerControl.Show.{identity}");
                showExisting.Set();
                if (startRequested)
                {
                    using var startExisting = EventWaitHandle.OpenExisting($"Local\\QZZ.ServerControl.Start.{identity}");
                    startExisting.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException) { }
            return;
        }

        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset,
            $"Local\\QZZ.ServerControl.Show.{identity}");
        using var startEvent = new EventWaitHandle(false, EventResetMode.AutoReset,
            $"Local\\QZZ.ServerControl.Start.{identity}");
        Application.Run(new ControlWindow(root, showEvent, startEvent,
            args.Contains("--autostart", StringComparer.OrdinalIgnoreCase), startRequested));
    }

    private static string? FindProjectRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; directory is not null && i < 6; i++, directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "server", "index.js"))) return directory.FullName;
        }
        return null;
    }
}

internal sealed class Settings
{
    public int Port { get; set; } = 3210;
    public bool AutoStart { get; set; }
    public string AiBaseUrl { get; set; } = "https://api.openai.com/v1/";
    public string AiModel { get; set; } = "";
    public string EncryptedAiKey { get; set; } = "";
}

internal sealed class ControlWindow : Form
{
    private const string RunKeyName = "QZZ Test Platform";
    private readonly string root;
    private readonly string settingsPath;
    private readonly EventWaitHandle showEvent;
    private readonly EventWaitHandle startEvent;
    private readonly NotifyIcon tray;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(1) };
    private readonly NumericUpDown portInput = new() { Minimum = 1024, Maximum = 65535, Width = 110 };
    private readonly CheckBox autoStartInput = new() { Text = "登录 Windows 后自动开启服务", AutoSize = true };
    private readonly TextBox aiUrlInput = new() { Width = 350 };
    private readonly TextBox aiModelInput = new() { Width = 240 };
    private readonly TextBox aiKeyInput = new() { Width = 350, UseSystemPasswordChar = true, PlaceholderText = "留空表示保留已有密钥" };
    private readonly Label status = new() { Text = "未启动", AutoSize = true, Font = new Font("Microsoft YaHei UI", 12, FontStyle.Bold) };
    private readonly TextBox urlOutput = new() { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Width = 520, Height = 92 };
    private readonly TextBox logOutput = new() { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Width = 520, Height = 104 };
    private readonly Button startButton = new() { Text = "启动服务", Width = 112, Height = 34 };
    private readonly Button stopButton = new() { Text = "停止服务", Width = 112, Height = 34, Enabled = false };
    private readonly Button browserButton = new() { Text = "打开网页", Width = 112, Height = 34, Enabled = false };
    private readonly Button credentialsButton = new() { Text = "首次登录凭据", AutoSize = true };
    private readonly Button saveButton = new() { Text = "保存配置", Width = 112, Height = 32 };
    private readonly Button clearKeyButton = new() { Text = "清除密钥", AutoSize = true };
    private Settings settings;
    private Process? serverProcess;
    private IntPtr jobHandle;
    private int runningPort;
    private bool starting;
    private bool exiting;

    public ControlWindow(string root, EventWaitHandle showEvent, EventWaitHandle startEvent, bool autoLaunch, bool startRequested)
    {
        this.root = root;
        this.showEvent = showEvent;
        this.startEvent = startEvent;
        settingsPath = Path.Combine(root, "data", "controller.json");
        settings = LoadSettings();

        Text = "QZZ 公共测试平台 - 服务控制";
        Icon = SystemIcons.Application;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(625, 680);
        ClientSize = new Size(625, 680);
        Font = new Font("Microsoft YaHei UI", 9);

        tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "QZZ 公共测试平台",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip()
        };
        tray.ContextMenuStrip.Items.Add("打开控制台", null, (_, _) => ShowWindow());
        tray.ContextMenuStrip.Items.Add("启动服务", null, async (_, _) => await StartServerAsync());
        tray.ContextMenuStrip.Items.Add("停止服务", null, (_, _) => StopServer());
        tray.ContextMenuStrip.Items.Add(new ToolStripSeparator());
        tray.ContextMenuStrip.Items.Add("退出", null, (_, _) => ExitApplication());
        tray.DoubleClick += (_, _) => ShowWindow();

        BuildLayout();
        portInput.Value = Math.Clamp(settings.Port, 1024, 65535);
        autoStartInput.Checked = settings.AutoStart;
        aiUrlInput.Text = settings.AiBaseUrl;
        aiModelInput.Text = settings.AiModel;
        RefreshUrls((int)portInput.Value);
        RefreshCredentials();

        startButton.Click += async (_, _) => await StartServerAsync();
        stopButton.Click += (_, _) => StopServer();
        browserButton.Click += (_, _) => OpenBrowser();
        credentialsButton.Click += (_, _) => OpenCredentials();
        saveButton.Click += (_, _) => SaveSettings();
        clearKeyButton.Click += (_, _) => ClearKey();
        portInput.ValueChanged += (_, _) => { if (serverProcess is null) RefreshUrls((int)portInput.Value); };
        FormClosing += (_, e) =>
        {
            if (!exiting)
            {
                e.Cancel = true;
                Hide();
            }
        };
        FormClosed += (_, _) =>
        {
            StopServer();
            tray.Visible = false;
            tray.Dispose();
            showEvent.Set();
            http.Dispose();
        };

        Task.Run(() =>
        {
            while (true)
            {
                var requestedEvent = WaitHandle.WaitAny(new WaitHandle[] { showEvent, startEvent });
                if (exiting || IsDisposed) return;
                try
                {
                    if (IsHandleCreated) BeginInvoke(async () =>
                    {
                        ShowWindow();
                        if (requestedEvent == 1) await StartServerAsync();
                    });
                }
                catch (InvalidOperationException) { return; }
            }
        });

        Shown += async (_, _) =>
        {
            if (startRequested)
            {
                await StartServerAsync();
            }
            else if (autoLaunch && settings.AutoStart)
            {
                Hide();
                await StartServerAsync();
            }
        };
    }

    private void BuildLayout()
    {
        var tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(16, 7) };
        var runTab = new TabPage("运行") { Padding = new Padding(22, 18, 18, 14) };
        var configTab = new TabPage("配置") { Padding = new Padding(22, 18, 18, 14) };
        tabs.TabPages.Add(runTab);
        tabs.TabPages.Add(configTab);
        Controls.Add(tabs);

        var run = VerticalPanel();
        runTab.Controls.Add(run);
        run.Controls.Add(new Label { Text = "服务状态", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        run.Controls.Add(status);
        run.Controls.Add(new Label { Text = " ", Height = 8 });
        var buttons = HorizontalPanel();
        buttons.Controls.Add(startButton);
        buttons.Controls.Add(stopButton);
        buttons.Controls.Add(browserButton);
        run.Controls.Add(buttons);
        run.Controls.Add(new Label { Text = " ", Height = 12 });
        run.Controls.Add(new Label { Text = "可访问地址", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        run.Controls.Add(urlOutput);
        var urlActions = HorizontalPanel();
        var copyButton = new Button { Text = "复制地址", AutoSize = true };
        copyButton.Click += (_, _) => Clipboard.SetText(urlOutput.Text);
        urlActions.Controls.Add(copyButton);
        urlActions.Controls.Add(credentialsButton);
        run.Controls.Add(urlActions);
        run.Controls.Add(new Label { Text = " ", Height = 12 });
        run.Controls.Add(new Label { Text = "运行记录", AutoSize = true, Font = new Font(Font, FontStyle.Bold) });
        run.Controls.Add(logOutput);

        var config = VerticalPanel();
        configTab.Controls.Add(config);
        config.Controls.Add(new Label { Text = "服务端口", AutoSize = true });
        config.Controls.Add(portInput);
        config.Controls.Add(autoStartInput);
        config.Controls.Add(new Label { Text = " ", Height = 12 });
        config.Controls.Add(new Label { Text = "AI 接口地址", AutoSize = true });
        config.Controls.Add(aiUrlInput);
        config.Controls.Add(new Label { Text = "AI 模型名称", AutoSize = true });
        config.Controls.Add(aiModelInput);
        config.Controls.Add(new Label { Text = "AI API 密钥", AutoSize = true });
        config.Controls.Add(aiKeyInput);
        config.Controls.Add(clearKeyButton);
        config.Controls.Add(new Label { Text = " ", Height = 12 });
        config.Controls.Add(saveButton);
        tabs.SelectedTab = runTab;
    }

    private static FlowLayoutPanel VerticalPanel() => new()
    {
        Dock = DockStyle.Fill,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        AutoScroll = true
    };

    private static FlowLayoutPanel HorizontalPanel() => new()
    {
        FlowDirection = FlowDirection.LeftToRight,
        AutoSize = true,
        WrapContents = false
    };

    private Settings LoadSettings()
    {
        try
        {
            if (File.Exists(settingsPath))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(settingsPath)) ?? new Settings();
        }
        catch (Exception error)
        {
            MessageBox.Show($"配置文件无法读取，将使用默认值：{error.Message}", "QZZ 测试平台");
        }
        return new Settings();
    }

    private bool SaveSettings(bool clearKey = false)
    {
        try
        {
            if (!Uri.TryCreate(aiUrlInput.Text.Trim(), UriKind.Absolute, out var aiUrl) ||
                (aiUrl.Scheme != Uri.UriSchemeHttps && aiUrl.Scheme != Uri.UriSchemeHttp))
                throw new InvalidOperationException("AI 接口地址必须是有效的 HTTP 或 HTTPS 地址");

            var updated = new Settings
            {
                Port = (int)portInput.Value,
                AutoStart = autoStartInput.Checked,
                AiBaseUrl = aiUrl.ToString(),
                AiModel = aiModelInput.Text.Trim(),
                EncryptedAiKey = clearKey ? "" : settings.EncryptedAiKey
            };
            if (!clearKey && !string.IsNullOrWhiteSpace(aiKeyInput.Text))
            {
                var bytes = Encoding.UTF8.GetBytes(aiKeyInput.Text.Trim());
                updated.EncryptedAiKey = Convert.ToBase64String(
                    ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser));
                Array.Clear(bytes);
                aiKeyInput.Clear();
            }
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
            var temporary = settingsPath + ".tmp";
            using var runKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)
                ?? throw new InvalidOperationException("无法配置 Windows 登录启动项");
            var previousRunValue = runKey.GetValue(RunKeyName) as string;
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(updated, new JsonSerializerOptions { WriteIndented = true }));
                SetLoginStartup(runKey, updated.AutoStart);
                File.Move(temporary, settingsPath, true);
            }
            catch
            {
                if (previousRunValue is null) runKey.DeleteValue(RunKeyName, false);
                else runKey.SetValue(RunKeyName, previousRunValue);
                throw;
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
            settings = updated;
            if (clearKey) aiKeyInput.Clear();
            RefreshUrls(serverProcess is null ? settings.Port : runningPort);
            AppendLog(serverProcess is null ? "配置已保存。" : "配置已保存，下次启动服务时生效。");
            return true;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "保存配置失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    private static void SetLoginStartup(RegistryKey key, bool enabled)
    {
        if (enabled)
            key.SetValue(RunKeyName, $"\"{Environment.ProcessPath}\" --autostart");
        else
            key.DeleteValue(RunKeyName, false);
    }

    private void ClearKey()
    {
        if (MessageBox.Show("确定删除已保存的 AI API 密钥？", "QZZ 测试平台",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        SaveSettings(clearKey: true);
    }

    private async Task StartServerAsync()
    {
        if (starting || serverProcess is not null) return;
        starting = true;
        startButton.Enabled = false;
        try
        {
            var node = FindNode();
            if (node is null) throw new InvalidOperationException("找不到 Node.js，请先安装 Node.js 22 或更新版本");
            var port = settings.Port;
            using (var probe = new TcpClient())
            {
                try
                {
                    await probe.ConnectAsync(IPAddress.Loopback, port).WaitAsync(TimeSpan.FromMilliseconds(250));
                    throw new InvalidOperationException($"端口 {port} 已被其他程序占用，请更换端口");
                }
                catch (SocketException) { }
                catch (TimeoutException) { }
            }

            var process = new Process
            {
                StartInfo = new ProcessStartInfo(node)
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                },
                EnableRaisingEvents = true
            };
            process.StartInfo.ArgumentList.Add(Path.Combine(root, "server", "index.js"));
            process.StartInfo.Environment["PORT"] = port.ToString();
            process.StartInfo.Environment["AI_BASE_URL"] = settings.AiBaseUrl;
            process.StartInfo.Environment["AI_MODEL"] = settings.AiModel;
            if (!string.IsNullOrWhiteSpace(settings.EncryptedAiKey))
            {
                var cipher = Convert.FromBase64String(settings.EncryptedAiKey);
                var plain = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser);
                process.StartInfo.Environment["AI_API_KEY"] = Encoding.UTF8.GetString(plain);
                Array.Clear(plain);
            }
            process.OutputDataReceived += (_, e) => { if (e.Data is not null) PostLog(e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data is not null) PostLog(e.Data); };
            process.Exited += (_, _) =>
            {
                try
                {
                    if (!IsDisposed && IsHandleCreated) BeginInvoke(() => ServerExited(process));
                }
                catch (InvalidOperationException) { }
            };
            if (!process.Start()) throw new InvalidOperationException("无法启动服务进程");
            try
            {
                jobHandle = NativeJob.CreateKillOnCloseJob(process);
            }
            catch
            {
                process.Kill(entireProcessTree: true);
                process.Dispose();
                throw;
            }
            serverProcess = process;
            runningPort = port;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            status.Text = "正在启动...";
            status.ForeColor = Color.DarkGoldenrod;
            startButton.Enabled = false;
            stopButton.Enabled = true;
            RefreshUrls(port);
            AppendLog($"正在启动服务，端口 {port}。");

            for (var attempt = 0; attempt < 30 && ReferenceEquals(serverProcess, process) && !process.HasExited; attempt++)
            {
                await Task.Delay(300);
                if (!ReferenceEquals(serverProcess, process)) return;
                try
                {
                    using var response = await http.GetAsync($"http://127.0.0.1:{port}/api/health");
                    if (!ReferenceEquals(serverProcess, process)) return;
                    if (response.IsSuccessStatusCode && !process.HasExited)
                    {
                        status.Text = "运行中";
                        status.ForeColor = Color.ForestGreen;
                        browserButton.Enabled = true;
                        tray.Text = $"QZZ 公共测试平台 - 运行中 :{port}";
                        RefreshCredentials();
                        return;
                    }
                }
                catch (HttpRequestException) { }
                catch (TaskCanceledException) { }
            }
            if (ReferenceEquals(serverProcess, process) && !process.HasExited)
                AppendLog("服务尚未通过健康检查，请查看运行记录。");
        }
        catch (Exception error)
        {
            AppendLog($"启动失败：{error.Message}");
            status.Text = "启动失败";
            status.ForeColor = Color.Firebrick;
            if (!Visible) tray.ShowBalloonTip(5000, "QZZ 测试平台", error.Message, ToolTipIcon.Error);
        }
        finally
        {
            starting = false;
            if (serverProcess is null) startButton.Enabled = true;
        }
    }

    private void ServerExited(Process process)
    {
        if (!ReferenceEquals(serverProcess, process)) return;
        AppendLog($"服务已退出（退出码 {process.ExitCode}）。");
        ReleaseProcess();
    }

    private void StopServer()
    {
        if (serverProcess is null) return;
        if (jobHandle != IntPtr.Zero)
        {
            NativeJob.CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
        }
        else if (!serverProcess.HasExited) serverProcess.Kill(entireProcessTree: true);
        AppendLog("服务已停止。");
        ReleaseProcess();
    }

    private void ReleaseProcess()
    {
        if (jobHandle != IntPtr.Zero)
        {
            NativeJob.CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
        }
        serverProcess?.Dispose();
        serverProcess = null;
        startButton.Enabled = true;
        stopButton.Enabled = false;
        browserButton.Enabled = false;
        status.Text = "未启动";
        status.ForeColor = SystemColors.ControlText;
        tray.Text = "QZZ 公共测试平台 - 未启动";
        RefreshUrls(settings.Port);
    }

    private void RefreshUrls(int port)
    {
        var addresses = new List<string> { $"http://localhost:{port}" };
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up ||
                nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
            foreach (var address in nic.GetIPProperties().UnicastAddresses)
            {
                if (address.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                var bytes = address.Address.GetAddressBytes();
                if (bytes[0] == 10 || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
                    (bytes[0] == 192 && bytes[1] == 168))
                    addresses.Add($"http://{address.Address}:{port}");
            }
        }
        urlOutput.Text = string.Join(Environment.NewLine, addresses.Distinct());
    }

    private static string? FindNode()
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
        foreach (var directory in paths)
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            var candidate = Path.Combine(directory.Trim('"'), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        var standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(standard) ? standard : null;
    }

    private void OpenBrowser()
    {
        if (serverProcess is null) return;
        Process.Start(new ProcessStartInfo($"http://localhost:{runningPort}") { UseShellExecute = true });
    }

    private void RefreshCredentials()
    {
        credentialsButton.Enabled = File.Exists(Path.Combine(root, "data", "initial-admin.txt"));
    }

    private void OpenCredentials()
    {
        var path = Path.Combine(root, "data", "initial-admin.txt");
        if (File.Exists(path)) Process.Start(new ProcessStartInfo("notepad.exe", $"\"{path}\"") { UseShellExecute = true });
        else RefreshCredentials();
    }

    private void AppendLog(string line)
    {
        var lines = logOutput.Lines.TakeLast(59).Append($"{DateTime.Now:HH:mm:ss} {line}");
        logOutput.Lines = lines.ToArray();
        logOutput.SelectionStart = logOutput.TextLength;
        logOutput.ScrollToCaret();
    }

    private void PostLog(string line)
    {
        try { if (!IsDisposed && IsHandleCreated) BeginInvoke(() => AppendLog(line)); }
        catch (InvalidOperationException) { }
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        exiting = true;
        Close();
    }
}

internal static class NativeJob
{
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public IntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr handle);

    internal static IntPtr CreateKillOnCloseJob(Process process)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var limit = new ExtendedLimitInformation();
        limit.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var length = Marshal.SizeOf<ExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limit, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length) ||
                !AssignProcessToJobObject(job, process.Handle))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }
}
