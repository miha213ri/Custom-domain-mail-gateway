using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace MailGateway.Installer
{
    public class MainForm : Form
    {
        private Panel headerPanel;
        private Label lblTitle;
        private Label lblSubtitle;
        private Panel statusCard;
        private Label lblStatusIcon;
        private Label lblStatusText;
        private Label lblVersionInfo;
        private ProgressBar progressBar;
        private Button btnInstall;
        private Label lblBrowserSection;
        private FlowLayoutPanel browserButtonsPanel;
        private Button btnOpenFolder;
        private Button btnCopyPath;
        private Label lblInstructions;

        private string installDir;
        private string versionFilePath;
        private string latestVersion = "1.4.2";
        private string downloadUrl = "https://gateway.tvoja-domena.si/prenos";
        private string localVersion = "Ni nameščeno";

        public MainForm()
        {
            InitializeComponent();
            SetupPaths();
            CheckCurrentLocalVersion();
            CheckServerForUpdatesAsync();
        }

        private void SetupPaths()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            installDir = Path.Combine(localAppData, "MailGateway", "extension");
            versionFilePath = Path.Combine(localAppData, "MailGateway", "version.txt");
        }

        private void InitializeComponent()
        {
            this.Text = "Mail Gateway – Namestitveni pomočnik";
            this.Size = new Size(580, 640);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(248, 249, 250);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            // Header Panel
            headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 85;
            headerPanel.BackColor = Color.FromArgb(26, 94, 154);

            lblTitle = new Label();
            lblTitle.Text = "✉ Mail Gateway";
            lblTitle.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(24, 16);
            lblTitle.AutoSize = true;

            lblSubtitle = new Label();
            lblSubtitle.Text = "Samodejni namestitveni pomočnik in posodobitve za Gmail";
            lblSubtitle.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblSubtitle.ForeColor = Color.FromArgb(215, 230, 245);
            lblSubtitle.Location = new Point(26, 48);
            lblSubtitle.AutoSize = true;

            headerPanel.Controls.Add(lblTitle);
            headerPanel.Controls.Add(lblSubtitle);

            // Status Card
            statusCard = new Panel();
            statusCard.Location = new Point(24, 105);
            statusCard.Size = new Size(516, 90);
            statusCard.BackColor = Color.FromArgb(232, 240, 254);
            statusCard.BorderStyle = BorderStyle.FixedSingle;

            lblStatusIcon = new Label();
            lblStatusIcon.Text = "ℹ";
            lblStatusIcon.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            lblStatusIcon.ForeColor = Color.FromArgb(26, 94, 154);
            lblStatusIcon.Location = new Point(14, 15);
            lblStatusIcon.Size = new Size(30, 30);

            lblStatusText = new Label();
            lblStatusText.Text = "Preverjanje povezave s strežnikom gateway.tvoja-domena.si...";
            lblStatusText.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            lblStatusText.ForeColor = Color.FromArgb(32, 33, 36);
            lblStatusText.Location = new Point(50, 16);
            lblStatusText.Size = new Size(450, 22);

            lblVersionInfo = new Label();
            lblVersionInfo.Text = "Lokalna različica: preverjam...";
            lblVersionInfo.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblVersionInfo.ForeColor = Color.FromArgb(95, 99, 104);
            lblVersionInfo.Location = new Point(50, 42);
            lblVersionInfo.Size = new Size(450, 36);

            statusCard.Controls.Add(lblStatusIcon);
            statusCard.Controls.Add(lblStatusText);
            statusCard.Controls.Add(lblVersionInfo);

            // Progress bar
            progressBar = new ProgressBar();
            progressBar.Location = new Point(24, 205);
            progressBar.Size = new Size(516, 12);
            progressBar.Visible = false;

            // Main Install / Update Button
            btnInstall = new Button();
            btnInstall.Text = "📥  Namesti ali posodobi razširitev";
            btnInstall.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            btnInstall.BackColor = Color.FromArgb(26, 94, 154);
            btnInstall.ForeColor = Color.White;
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Location = new Point(24, 225);
            btnInstall.Size = new Size(516, 46);
            btnInstall.Cursor = Cursors.Hand;
            btnInstall.Click += BtnInstall_Click;

            // Browser Section Header
            lblBrowserSection = new Label();
            lblBrowserSection.Text = "Izberite vaš brskalnik za odpiranje razširitev:";
            lblBrowserSection.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            lblBrowserSection.ForeColor = Color.FromArgb(32, 33, 36);
            lblBrowserSection.Location = new Point(24, 290);
            lblBrowserSection.AutoSize = true;

            // Browser Buttons Panel
            browserButtonsPanel = new FlowLayoutPanel();
            browserButtonsPanel.Location = new Point(24, 318);
            browserButtonsPanel.Size = new Size(520, 90);
            browserButtonsPanel.AutoScroll = false;

            AddBrowserButton("🦁  Brave", "brave.exe", "brave://extensions");
            AddBrowserButton("🌐  Chrome", "chrome.exe", "chrome://extensions");
            AddBrowserButton("🎮  Opera GX", "launcher.exe", "opera://extensions");
            AddBrowserButton("🦊  Firefox", "firefox.exe", "about:debugging#/runtime/this-firefox");
            AddBrowserButton("🌊  Edge", "msedge.exe", "edge://extensions");

            // Utility Buttons: Copy Path & Open Folder
            btnCopyPath = new Button();
            btnCopyPath.Text = "📋  Kopiraj pot do mape razširitve";
            btnCopyPath.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            btnCopyPath.BackColor = Color.FromArgb(241, 243, 244);
            btnCopyPath.ForeColor = Color.FromArgb(26, 94, 154);
            btnCopyPath.FlatStyle = FlatStyle.Flat;
            btnCopyPath.FlatAppearance.BorderColor = Color.FromArgb(218, 220, 224);
            btnCopyPath.Location = new Point(24, 420);
            btnCopyPath.Size = new Size(250, 36);
            btnCopyPath.Cursor = Cursors.Hand;
            btnCopyPath.Click += (s, e) => {
                if (Directory.Exists(installDir)) {
                    Clipboard.SetText(installDir);
                    MessageBox.Show("Pot do mape je kopirana v odložišče:\n\n" + installDir, "Pot kopirana", MessageBoxButtons.OK, MessageBoxIcon.Information);
                } else {
                    MessageBox.Show("Najprej kliknite gumb 'Namesti ali posodobi razširitev'.", "Obvestilo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };

            btnOpenFolder = new Button();
            btnOpenFolder.Text = "📁  Odpri mapo v Raziskovalcu";
            btnOpenFolder.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            btnOpenFolder.BackColor = Color.FromArgb(241, 243, 244);
            btnOpenFolder.ForeColor = Color.FromArgb(26, 94, 154);
            btnOpenFolder.FlatStyle = FlatStyle.Flat;
            btnOpenFolder.FlatAppearance.BorderColor = Color.FromArgb(218, 220, 224);
            btnOpenFolder.Location = new Point(290, 420);
            btnOpenFolder.Size = new Size(250, 36);
            btnOpenFolder.Cursor = Cursors.Hand;
            btnOpenFolder.Click += (s, e) => {
                if (Directory.Exists(installDir)) {
                    Process.Start("explorer.exe", installDir);
                } else {
                    MessageBox.Show("Najprej kliknite gumb 'Namesti ali posodobi razširitev'.", "Obvestilo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };

            // Instructions text
            lblInstructions = new Label();
            lblInstructions.Text = "Navodila za prvi vklop v brskalniku:\n" +
                                   "1. Kliknite zgoraj na gumb vašega brskalnika.\n" +
                                   "2. V brskalniku vklopite 'Razvijalski način' (Developer mode).\n" +
                                   "3. Kliknite 'Naloži nepakirano' (Load unpacked) in izberite odprto mapo.\n" +
                                   "4. Kliknite na ikono razširitve zgoraj in vpišite vaš API ključ ter svoj e-mail.";
            lblInstructions.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblInstructions.ForeColor = Color.FromArgb(95, 99, 104);
            lblInstructions.Location = new Point(24, 470);
            lblInstructions.Size = new Size(516, 110);

            // Add all controls
            this.Controls.Add(headerPanel);
            this.Controls.Add(statusCard);
            this.Controls.Add(progressBar);
            this.Controls.Add(btnInstall);
            this.Controls.Add(lblBrowserSection);
            this.Controls.Add(browserButtonsPanel);
            this.Controls.Add(btnCopyPath);
            this.Controls.Add(btnOpenFolder);
            this.Controls.Add(lblInstructions);
        }

        private void AddBrowserButton(string label, string exeName, string url)
        {
            Button btn = new Button();
            btn.Text = label;
            btn.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btn.BackColor = Color.White;
            btn.ForeColor = Color.FromArgb(32, 33, 36);
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderColor = Color.FromArgb(218, 220, 224);
            btn.Size = new Size(165, 36);
            btn.Margin = new Padding(0, 0, 8, 8);
            btn.Cursor = Cursors.Hand;
            btn.Click += (s, e) => LaunchBrowser(exeName, url);
            browserButtonsPanel.Controls.Add(btn);
        }

        private void LaunchBrowser(string exeName, string url)
        {
            try
            {
                // Če razširitev obstaja, pot samodejno kopiraj v odložišče za lažje lepljenje
                if (Directory.Exists(installDir))
                {
                    Clipboard.SetText(installDir);
                }

                string exePath = FindBrowserExecutable(exeName);
                if (!string.IsNullOrEmpty(exePath))
                {
                    Process.Start(exePath, url);
                }
                else
                {
                    Process.Start(url);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Napaka pri zagonu brskalnika: " + ex.Message, "Napaka", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string FindBrowserExecutable(string exeName)
        {
            string[] possibleDirs = new string[] {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
            };

            if (exeName == "brave.exe")
            {
                foreach (var baseDir in possibleDirs)
                {
                    string p = Path.Combine(baseDir, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
                    if (File.Exists(p)) return p;
                }
            }
            else if (exeName == "chrome.exe")
            {
                foreach (var baseDir in possibleDirs)
                {
                    string p = Path.Combine(baseDir, "Google", "Chrome", "Application", "chrome.exe");
                    if (File.Exists(p)) return p;
                }
            }
            else if (exeName == "launcher.exe") // Opera GX / Opera
            {
                foreach (var baseDir in possibleDirs)
                {
                    string p1 = Path.Combine(baseDir, "Programs", "Opera GX", "launcher.exe");
                    if (File.Exists(p1)) return p1;
                    string p2 = Path.Combine(baseDir, "Opera GX", "launcher.exe");
                    if (File.Exists(p2)) return p2;
                    string p3 = Path.Combine(baseDir, "Programs", "Opera", "launcher.exe");
                    if (File.Exists(p3)) return p3;
                }
            }
            else if (exeName == "firefox.exe")
            {
                foreach (var baseDir in possibleDirs)
                {
                    string p = Path.Combine(baseDir, "Mozilla Firefox", "firefox.exe");
                    if (File.Exists(p)) return p;
                }
            }
            else if (exeName == "msedge.exe")
            {
                foreach (var baseDir in possibleDirs)
                {
                    string p = Path.Combine(baseDir, "Microsoft", "Edge", "Application", "msedge.exe");
                    if (File.Exists(p)) return p;
                }
            }

            return null;
        }

        private void CheckCurrentLocalVersion()
        {
            if (File.Exists(versionFilePath))
            {
                try
                {
                    localVersion = File.ReadAllText(versionFilePath).Trim();
                }
                catch { localVersion = "1.4.2"; }
            }
            else if (Directory.Exists(installDir) && File.Exists(Path.Combine(installDir, "manifest.json")))
            {
                localVersion = "1.4.2";
            }
            else
            {
                localVersion = "Še ni nameščeno";
            }

            UpdateVersionLabel();
        }

        private void UpdateVersionLabel()
        {
            lblVersionInfo.Text = string.Format("Nameščena različica: {0}  |  Na strežniku: {1}", localVersion, latestVersion);
        }

        private void CheckServerForUpdatesAsync()
        {
            Thread t = new Thread(() =>
            {
                try
                {
                    // Omogoči TLS 1.2
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | SecurityProtocolType.Tls;

                    using (WebClient client = new WebClient())
                    {
                        client.Headers.Add("User-Agent", "MailGatewayInstaller/1.0");
                        string json = client.DownloadString("https://gateway.tvoja-domena.si/api/v5/version");
                        Match mVer = Regex.Match(json, "\"extension_version\"\\s*:\\s*\"([^\"]+)\"");
                        if (mVer.Success)
                        {
                            latestVersion = mVer.Groups[1].Value;
                        }
                        Match mUrl = Regex.Match(json, "\"download_url\"\\s*:\\s*\"([^\"]+)\"");
                        if (mUrl.Success)
                        {
                            downloadUrl = mUrl.Groups[1].Value;
                        }
                    }

                    this.Invoke(new Action(() =>
                    {
                        UpdateVersionLabel();
                        if (localVersion == "Še ni nameščeno")
                        {
                            lblStatusIcon.Text = "★";
                            lblStatusIcon.ForeColor = Color.FromArgb(26, 94, 154);
                            lblStatusText.Text = "Pripravljeno za prvo namestitev (različica " + latestVersion + ")";
                            btnInstall.Text = "📥  Namesti Mail Gateway (" + latestVersion + ")";
                        }
                        else if (localVersion != latestVersion)
                        {
                            lblStatusIcon.Text = "🔔";
                            lblStatusIcon.ForeColor = Color.FromArgb(227, 116, 0);
                            lblStatusText.Text = "Na voljo je nova različica: " + latestVersion + "!";
                            btnInstall.Text = "🔄  Posodobi na različico " + latestVersion;
                            btnInstall.BackColor = Color.FromArgb(227, 116, 0);
                        }
                        else
                        {
                            lblStatusIcon.Text = "✓";
                            lblStatusIcon.ForeColor = Color.FromArgb(19, 115, 51);
                            lblStatusText.Text = "Imate najnovejšo različico (" + latestVersion + ")";
                            btnInstall.Text = "✓  Razširitev je posodobljena (Ponovno namesti)";
                        }
                    }));
                }
                catch (Exception)
                {
                    this.Invoke(new Action(() =>
                    {
                        lblStatusIcon.Text = "ℹ";
                        lblStatusText.Text = "Povezava s strežnikom ni na voljo (uporabljena bo vgrajena verzija).";
                        UpdateVersionLabel();
                    }));
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void BtnInstall_Click(object sender, EventArgs e)
        {
            btnInstall.Enabled = false;
            progressBar.Visible = true;
            progressBar.Style = ProgressBarStyle.Marquee;
            lblStatusText.Text = "Prenašam in nameščam razširitev...";

            Thread t = new Thread(() =>
            {
                bool success = false;
                string errorMsg = "";

                try
                {
                    string tempZip = Path.Combine(Path.GetTempPath(), "mail_gateway_setup_" + Guid.NewGuid().ToString("N") + ".zip");
                    bool downloaded = false;

                    // Poskusi prenos s strežnika
                    try
                    {
                        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | SecurityProtocolType.Tls;
                        using (WebClient client = new WebClient())
                        {
                            client.Headers.Add("User-Agent", "MailGatewayInstaller/1.0");
                            client.DownloadFile(downloadUrl, tempZip);
                            if (File.Exists(tempZip) && new FileInfo(tempZip).Length > 1000)
                            {
                                downloaded = true;
                            }
                        }
                    }
                    catch { downloaded = false; }

                    // Če prenos ni uspel, uporabi vdelan paket iz virov programa
                    if (!downloaded)
                    {
                        var assembly = Assembly.GetExecutingAssembly();
                        using (Stream stream = assembly.GetManifestResourceStream("extension.zip"))
                        {
                            if (stream != null)
                            {
                                using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                                {
                                    stream.CopyTo(fs);
                                }
                                downloaded = true;
                            }
                        }
                    }

                    if (!downloaded || !File.Exists(tempZip))
                    {
                        throw new Exception("Prenos datoteke s strežnika ni uspel, vdelana varnostna kopija pa ni dosegljiva.");
                    }

                    // Pripravi ciljno mapo
                    if (Directory.Exists(installDir))
                    {
                        try { Directory.Delete(installDir, true); } catch { }
                    }
                    Directory.CreateDirectory(installDir);

                    // Razpakiraj ZIP
                    ZipFile.ExtractToDirectory(tempZip, installDir);
                    try { File.Delete(tempZip); } catch { }

                    // Zapiši nameščeno različico
                    string appDir = Path.GetDirectoryName(installDir);
                    File.WriteAllText(versionFilePath, latestVersion);
                    localVersion = latestVersion;

                    success = true;
                }
                catch (Exception ex)
                {
                    errorMsg = ex.Message;
                }

                this.Invoke(new Action(() =>
                {
                    progressBar.Visible = false;
                    btnInstall.Enabled = true;

                    if (success)
                    {
                        lblStatusIcon.Text = "✓";
                        lblStatusIcon.ForeColor = Color.FromArgb(19, 115, 51);
                        lblStatusText.Text = "Razširitev je uspešno nameščena v mapo!";
                        btnInstall.Text = "✓  Uspešno nameščeno (Različica " + localVersion + ")";
                        btnInstall.BackColor = Color.FromArgb(19, 115, 51);
                        UpdateVersionLabel();

                        // Samodejno kopiraj pot v odložišče
                        Clipboard.SetText(installDir);

                        MessageBox.Show(
                            "✓ Mail Gateway razširitev je pripravljena v mapi:\n\n" + installDir + "\n\n" +
                            "Pot do mape je že samodejno kopirana v vaše odložišče (Ctrl+V)!\n\n" +
                            "Sedaj spodaj kliknite gumb vašega brskalnika, vklopite 'Razvijalski način' in kliknite 'Naloži nepakirano'.",
                            "Namestitev uspešna",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information
                        );
                    }
                    else
                    {
                        lblStatusIcon.Text = "❌";
                        lblStatusIcon.ForeColor = Color.Red;
                        lblStatusText.Text = "Napaka pri namestitvi: " + errorMsg;
                        MessageBox.Show("Napaka: " + errorMsg, "Napaka pri namestitvi", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                }));
            });

            t.IsBackground = true;
            t.Start();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
