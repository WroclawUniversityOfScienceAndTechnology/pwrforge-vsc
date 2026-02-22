import * as vscode from "vscode";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

type Status = {
  venvOk: boolean;
  python312Ok: boolean;
  dockerOk: boolean;
  dockerHint?: string;
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function venvPython(root: string): string {
  const isWin = process.platform === "win32";
  return isWin ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
}

function venvPwrforge(root: string): string {
  const isWin = process.platform === "win32";
  return isWin ? path.join(root, ".venv", "Scripts", "pwrforge.exe") : path.join(root, ".venv", "bin", "pwrforge");
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function execCheck(cmd: string, cwd: string): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, { cwd, shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ ok: code === 0, output: out, code }));
  });
}

let pwrforgeTerminal: vscode.Terminal | undefined;

function terminalOptions(cwd: string): vscode.TerminalOptions {
  if (process.platform === "win32") {
    return { name: "Pwrforge", cwd };
  }

  // Avoid loading user shell profiles in extension terminals.
  // This prevents unrelated startup errors from polluting command output.
  return {
    name: "Pwrforge",
    cwd,
    shellPath: "/bin/bash",
    shellArgs: ["--noprofile", "--norc"]
  };
}

function getPwrforgeTerminal(cwd: string): vscode.Terminal {
  if (!pwrforgeTerminal) {
    pwrforgeTerminal = vscode.window.createTerminal(terminalOptions(cwd));
  }
  return pwrforgeTerminal;
}

function quoteArg(arg: string): string {
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function runInTerminal(cmd: string, cwd: string) {
  const term = getPwrforgeTerminal(cwd);
  term.show(true);
  term.sendText(cmd, true);
}

function isPwrforgeRepo(root: string): boolean {
  // prosta detekcja: jak jesteś w repo pwrforge, masz katalog "pwrforge" i pyproject.toml
  return exists(path.join(root, "pyproject.toml")) && exists(path.join(root, "pwrforge"));
}

async function ensureVenv(root: string) {
  const py = venvPython(root);
  const cli = venvPwrforge(root);

  if (!exists(py)) {
    const py312 = await execCheck("python3.12 --version", root);
    if (!py312.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie widzę python3.12 w PATH. Zainstaluj Python 3.12 (z venv).");
      throw new Error("python3.12 missing");
    }

    const venv = await execCheck("python3.12 -m venv .venv", root);
    if (!venv.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie udało się utworzyć .venv:\n" + venv.output);
      throw new Error("venv create failed");
    }

    await execCheck(`${quoteArg(py)} -m pip install --upgrade pip`, root);
  }

  if (!exists(cli)) {
    // Jeśli użytkownik jest w repo pwrforge -> install editable, w innym wypadku PyPI
    const installCmd = isPwrforgeRepo(root)
      ? `${quoteArg(py)} -m pip install -e .`
      : `${quoteArg(py)} -m pip install pwrforge`;
    const install = await execCheck(installCmd, root);
    if (!install.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie udało się zainstalować pwrforge do .venv:\n" + install.output);
      throw new Error("pwrforge install failed");
    }
  }

  // ustaw interpreter VS Code (fallback)
  const vscodeDir = path.join(root, ".vscode");
  const settingsPath = path.join(vscodeDir, "settings.json");
  fs.mkdirSync(vscodeDir, { recursive: true });

  let settings: any = {};
  if (exists(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }
  settings["python.defaultInterpreterPath"] = py;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function dockerDoctor(root: string): Promise<{ ok: boolean; hint?: string; raw?: string }> {
  const r = await execCheck("docker version", root);
  if (r.ok) {
    return { ok: true };
  }

  const msg = r.output.toLowerCase();

  if (msg.includes("command not found") || msg.includes("not recognized")) {
    return { ok: false, hint: "Docker nie jest zainstalowany (docker command not found). Zainstaluj Docker Engine.", raw: r.output };
  }
  if (msg.includes("cannot connect") || msg.includes("is the docker daemon running")) {
    return { ok: false, hint: "Nie mogę połączyć się z Docker daemon. Uruchom usługę Docker.", raw: r.output };
  }
  if (msg.includes("permission denied") || msg.includes("got permission denied")) {
    return {
      ok: false,
      hint:
        "Brak uprawnień do Dockera (permission denied). Na Ubuntu zwykle pomaga: newgroup docker; sudo usermod -aG docker $USER; sudo systemctl restart docker; restart VS Code.",
      raw: r.output
    };
  }
  return { ok: false, hint: "Docker niedostępny lub błąd. Sprawdź docker version/info.", raw: r.output };
}

async function detectDockerInstallCommand(root: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    return "winget install -e --id Docker.DockerDesktop";
  }
  if (process.platform === "darwin") {
    return "brew install --cask docker";
  }

  // Linux best-effort per distro family.
  if ((await execCheck("command -v apt-get", root)).ok) {
    return "sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin && sudo systemctl enable --now docker";
  }
  if ((await execCheck("command -v dnf", root)).ok) {
    return "sudo dnf install -y docker docker-compose-plugin && sudo systemctl enable --now docker";
  }
  if ((await execCheck("command -v pacman", root)).ok) {
    return "sudo pacman -Sy --noconfirm docker docker-compose && sudo systemctl enable --now docker";
  }
  return undefined;
}

async function ensureDocker(root: string): Promise<boolean> {
  const d = await dockerDoctor(root);
  if (d.ok) {
    return true;
  }

  const pick = await vscode.window.showWarningMessage(
    `Pwrforge: ${d.hint ?? "Docker not available."} Install Docker now?`,
    { modal: true },
    "Install Docker",
    "Skip"
  );

  if (pick !== "Install Docker") {
    return false;
  }

  const installCmd = await detectDockerInstallCommand(root);
  if (!installCmd) {
    vscode.window.showErrorMessage(
      "Pwrforge: I cannot determine an automatic Docker install command for this OS. Please install Docker manually."
    );
    return false;
  }

  runInTerminal(installCmd, root);
  vscode.window.showInformationMessage(
    "Pwrforge: Docker install command started in terminal. Complete it, then run 'Pwrforge: Docker doctor'."
  );
  return false;
}

function pwrforgeCmd(root: string, subcmd: string, args: string[] = []): string {
  const cli = venvPwrforge(root);
  const parts = [subcmd, ...args].map(quoteArg).join(" ");
  return `${quoteArg(cli)} ${parts}`;
}

function needsLockFile(subcmd: string): boolean {
  return !["new", "version", "docker", "update"].includes(subcmd);
}

async function ensureProjectInitialized(root: string, subcmd: string): Promise<boolean> {
  if (!needsLockFile(subcmd)) {
    return true;
  }
  const lockPath = path.join(root, "pwrforge.lock");
  if (exists(lockPath)) {
    return true;
  }

  const action = await vscode.window.showWarningMessage(
    "Pwrforge: `pwrforge.lock` not found. Run `pwrforge update` first?",
    "Run Update",
    "Cancel"
  );
  if (action !== "Run Update") {
    return false;
  }

  runInTerminal(pwrforgeCmd(root, "update"), root);
  return false;
}

async function runPwrforge(subcmd: string, args: string[] = []): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) {
    return false;
  }

  await ensureVenv(root);
  if (!(await ensureProjectInitialized(root, subcmd))) {
    return false;
  }

  // Nie blokuj zawsze — ale pokaż ostrzeżenie. Część komend może działać bez dockera, część nie.
  const d = await dockerDoctor(root);
  if (!d.ok && d.hint) {
    vscode.window.showWarningMessage("Pwrforge: " + d.hint);
  }

  runInTerminal(pwrforgeCmd(root, subcmd, args), root);
  return true;
}

async function runPwrforgeNew() {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  await ensureVenv(root);

  const projectName = await vscode.window.showInputBox({
    title: "Pwrforge: New Project",
    prompt: "Project name (required)",
    placeHolder: "my_project",
    validateInput: (value) => (value.trim().length === 0 ? "PROJECT_NAME is required." : undefined)
  });
  if (!projectName) {
    return;
  }

  const includeDocker = await vscode.window.showQuickPick(
    [
      { label: "Docker enabled", value: "--docker" },
      { label: "No Docker", value: "--no-docker" }
    ],
    { title: "Pwrforge: New Project", placeHolder: "Docker setup" }
  );
  if (!includeDocker) {
    return;
  }

  const target = await vscode.window.showQuickPick(
    [
      { label: "x86", value: "x86" },
      { label: "stm32", value: "stm32" },
      { label: "esp32", value: "esp32" },
      { label: "atsam", value: "atsam" },
      { label: "Skip target", value: "" }
    ],
    { title: "Pwrforge: New Project", placeHolder: "Target (optional)" }
  );
  if (!target) {
    return;
  }

  const args = [includeDocker.value];
  if (target.value) {
    args.push("--target", target.value);
  }
  args.push(projectName.trim());

  runInTerminal(pwrforgeCmd(root, "new", args), root);
}

async function computeStatus(root: string): Promise<Status> {
  const py = venvPython(root);
  const venvOk = exists(py);

  const py312 = await execCheck("python3.12 --version", root);
  const python312Ok = py312.ok;

  const d = await dockerDoctor(root);
  return {
    venvOk,
    python312Ok,
    dockerOk: d.ok,
    dockerHint: d.ok ? undefined : d.hint
  };
}

class ActionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly commandId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (commandId) {
      this.command = { command: commandId, title: label };
    }
  }
}

class PwrforgeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private status: Status | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = workspaceRoot();
    if (!root) {
      return [new ActionItem("Open a workspace folder", "No folder opened")];
    }

    this.status = await computeStatus(root);

    const env = new vscode.TreeItem("Environment", vscode.TreeItemCollapsibleState.Expanded);

    const items: vscode.TreeItem[] = [];

    items.push(env);

    items.push(
      new ActionItem(
        this.status.venvOk ? "✅ .venv" : "⚠️ .venv missing",
        this.status.venvOk ? "Python venv ready" : "Run: Pwrforge: Setup",
        this.status.venvOk ? undefined : "pwrforge.setup"
      )
    );

    items.push(
      new ActionItem(
        this.status.python312Ok ? "✅ python3.12" : "⚠️ python3.12 missing",
        this.status.python312Ok ? "Available in PATH" : "Install Python 3.12",
        undefined
      )
    );

    items.push(
      new ActionItem(
        this.status.dockerOk ? "✅ docker" : "⚠️ docker issue",
        this.status.dockerOk ? "Docker OK" : (this.status.dockerHint ?? "Check docker"),
        "pwrforge.dockerDoctor"
      )
    );

    items.push(new vscode.TreeItem("Actions", vscode.TreeItemCollapsibleState.Expanded));

    items.push(new ActionItem("Build", "pwrforge build", "pwrforge.build"));
    items.push(new ActionItem("Test", "pwrforge test", "pwrforge.test"));
    items.push(new ActionItem("Check", "pwrforge check", "pwrforge.check"));
    items.push(new ActionItem("Fix", "pwrforge fix", "pwrforge.fix"));
    items.push(new ActionItem("More…", "choose other commands", "pwrforge.more"));

    return items;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === pwrforgeTerminal) {
        pwrforgeTerminal = undefined;
      }
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "Pwrforge: idle";
  statusBar.command = "pwrforge.more";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const provider = new PwrforgeViewProvider(context);
  vscode.window.registerTreeDataProvider("pwrforge_view", provider);

  async function updateStatusBar() {
    const root = workspaceRoot();
    if (!root) {
      statusBar.text = "Pwrforge: no workspace";
      return;
    }
    const s = await computeStatus(root);
    const v = s.venvOk ? "venv✓" : "venv!";
    const d = s.dockerOk ? "docker✓" : "docker!";
    statusBar.text = `Pwrforge: ${v} ${d}`;
    if (!s.dockerOk && s.dockerHint) {
      statusBar.tooltip = s.dockerHint;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pwrforge.refresh", async () => {
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.setup", async () => {
      const root = workspaceRoot();
      if (!root) {
        return;
      }
      await ensureVenv(root);
      const dockerOk = await ensureDocker(root);
      if (dockerOk) {
        vscode.window.showInformationMessage("Pwrforge: setup OK (.venv + docker).");
      } else {
        vscode.window.showWarningMessage("Pwrforge: .venv ready. Docker still needs attention.");
      }
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.dockerDoctor", async () => {
      const root = workspaceRoot();
      if (!root) {
        return;
      }
      const d = await dockerDoctor(root);
      if (d.ok) {
        vscode.window.showInformationMessage("Pwrforge: Docker OK.");
      } else {
        vscode.window.showWarningMessage("Pwrforge: " + (d.hint ?? "Docker problem"));
        if (d.raw) {
          console.warn(d.raw);
        }
      }
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.build", async () => {
      await runPwrforge("build");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.test", async () => {
      await runPwrforge("test");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.check", async () => {
      await runPwrforge("check");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.fix", async () => {
      await runPwrforge("fix");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.clean", async () => runPwrforge("clean")),
    vscode.commands.registerCommand("pwrforge.run", async () => runPwrforge("run")),
    vscode.commands.registerCommand("pwrforge.debug", async () => runPwrforge("debug")),
    vscode.commands.registerCommand("pwrforge.doc", async () => runPwrforge("doc")),
    vscode.commands.registerCommand("pwrforge.flash", async () => runPwrforge("flash")),
    vscode.commands.registerCommand("pwrforge.monitor", async () => runPwrforge("monitor")),
    vscode.commands.registerCommand("pwrforge.update", async () => runPwrforge("update")),
    vscode.commands.registerCommand("pwrforge.gen", async () => runPwrforge("gen")),
    vscode.commands.registerCommand("pwrforge.docker", async () => runPwrforge("docker")),
    vscode.commands.registerCommand("pwrforge.publish", async () => runPwrforge("publish")),
    vscode.commands.registerCommand("pwrforge.licenseCheck", async () => runPwrforge("license-check")),
    vscode.commands.registerCommand("pwrforge.new", async () => runPwrforgeNew()),
    vscode.commands.registerCommand("pwrforge.version", async () => runPwrforge("version")),

    vscode.commands.registerCommand("pwrforge.more", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "build", description: "Compile sources" },
          { label: "test", description: "Compile and run tests" },
          { label: "check", description: "Check source code" },
          { label: "fix", description: "Fix violations" },
          { label: "clean", description: "Remove build directory" },
          { label: "run", description: "Run project bin file" },
          { label: "debug", description: "Use gdb cli to debug" },
          { label: "doc", description: "Create project documentation" },
          { label: "flash", description: "Flash the target" },
          { label: "monitor", description: "Monitor target over serial" },
          { label: "update", description: "Update project files" },
          { label: "gen", description: "Auto file generator" },
          { label: "docker", description: "Manage docker env" },
          { label: "publish", description: "Upload conan pkg to repo" },
          { label: "license-check", description: "Check project licenses" },
          { label: "new", description: "Create new project template" },
          { label: "version", description: "Get pwrforge version" }
        ],
        { placeHolder: "Choose pwrforge command" }
      );
      if (!pick) {
        return;
      }
      if (pick.label === "new") {
        await runPwrforgeNew();
      } else {
        await runPwrforge(pick.label);
      }
      provider.refresh();
      await updateStatusBar();
    })
  );

  // initial refresh
  void updateStatusBar();
}

export function deactivate() {}
