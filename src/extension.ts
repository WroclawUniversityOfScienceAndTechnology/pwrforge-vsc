import * as vscode from "vscode";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

type Status = {
  activeProjectName?: string;
  venvOk: boolean;
  python312Ok: boolean;
  dockerOk: boolean;
  dockerHint?: string;
};

type ProjectContext = {
  workspaceRoot: string;
  projectRoot: string;
  sharedEnvRoot: string;
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

const PROJECT_PICK_STORAGE_KEY = "pwrforge.activeProjectRoot";

function projectName(projectRoot: string): string {
  return path.basename(projectRoot);
}

function listProjectFolders(root: string): string[] {
  const ignored = new Set([".git", ".vscode", ".venv", "node_modules", "dist", "out"]);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignored.has(entry.name))
    .map((entry) => path.join(root, entry.name));
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
let pwrforgeTerminalCwd: string | undefined;

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
  if (pwrforgeTerminal && pwrforgeTerminalCwd !== cwd) {
    pwrforgeTerminal.dispose();
    pwrforgeTerminal = undefined;
    pwrforgeTerminalCwd = undefined;
  }
  if (!pwrforgeTerminal) {
    pwrforgeTerminal = vscode.window.createTerminal(terminalOptions(cwd));
    pwrforgeTerminalCwd = cwd;
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

async function selectActiveProjectRoot(root: string): Promise<string | undefined> {
  const projects = listProjectFolders(root);
  if (projects.length === 0) {
    vscode.window.showWarningMessage("Pwrforge: no project subfolders found in workspace root.");
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: projectName(project),
      description: project,
      project
    })),
    { placeHolder: "Select active Pwrforge project" }
  );

  return pick?.project;
}

async function resolveProjectContext(
  context: vscode.ExtensionContext,
  forcePick = false,
  allowPrompt = true
): Promise<ProjectContext | undefined> {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }

  let selected = context.workspaceState.get<string>(PROJECT_PICK_STORAGE_KEY);
  if (!selected || !selected.startsWith(root) || !exists(selected) || forcePick) {
    if (!allowPrompt) {
      return undefined;
    }
    selected = await selectActiveProjectRoot(root);
    if (!selected) {
      return undefined;
    }
    await context.workspaceState.update(PROJECT_PICK_STORAGE_KEY, selected);
  }

  return {
    workspaceRoot: root,
    projectRoot: selected,
    sharedEnvRoot: path.dirname(selected)
  };
}

async function ensureVenv(sharedEnvRoot: string, projectRoot: string, workspaceRootForEditableInstall?: string) {
  const py = venvPython(sharedEnvRoot);
  const cli = venvPwrforge(sharedEnvRoot);

  if (!exists(py)) {
    const py312 = await execCheck("python3.12 --version", projectRoot);
    if (!py312.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie widzę python3.12 w PATH. Zainstaluj Python 3.12 (z venv).");
      throw new Error("python3.12 missing");
    }

    const venv = await execCheck("python3.12 -m venv .venv", sharedEnvRoot);
    if (!venv.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie udało się utworzyć .venv:\n" + venv.output);
      throw new Error("venv create failed");
    }

    await execCheck(`${quoteArg(py)} -m pip install --upgrade pip`, sharedEnvRoot);
  }

  if (!exists(cli)) {
    // Jeśli użytkownik jest w repo pwrforge -> install editable, w innym wypadku PyPI
    const installCmd = workspaceRootForEditableInstall && isPwrforgeRepo(workspaceRootForEditableInstall)
      ? `${quoteArg(py)} -m pip install -e .`
      : `${quoteArg(py)} -m pip install pwrforge`;
    const installCwd = workspaceRootForEditableInstall && isPwrforgeRepo(workspaceRootForEditableInstall)
      ? workspaceRootForEditableInstall
      : sharedEnvRoot;
    const install = await execCheck(installCmd, installCwd);
    if (!install.ok) {
      vscode.window.showErrorMessage("Pwrforge: nie udało się zainstalować pwrforge do .venv:\n" + install.output);
      throw new Error("pwrforge install failed");
    }
  }

  // ustaw interpreter VS Code (fallback)
  const vscodeDir = path.join(projectRoot, ".vscode");
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

function pwrforgeCmd(sharedEnvRoot: string, subcmd: string, args: string[] = []): string {
  const cli = venvPwrforge(sharedEnvRoot);
  const parts = [subcmd, ...args].map(quoteArg).join(" ");
  return `${quoteArg(cli)} ${parts}`;
}

function needsLockFile(subcmd: string): boolean {
  return !["new", "version", "docker", "update"].includes(subcmd);
}

async function ensureProjectInitialized(ctx: ProjectContext, subcmd: string): Promise<boolean> {
  if (!needsLockFile(subcmd)) {
    return true;
  }
  const lockPath = path.join(ctx.projectRoot, "pwrforge.lock");
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

  runInTerminal(pwrforgeCmd(ctx.sharedEnvRoot, "update"), ctx.projectRoot);
  return false;
}

async function runPwrforge(ctx: ProjectContext, subcmd: string, args: string[] = []): Promise<boolean> {
  await ensureVenv(ctx.sharedEnvRoot, ctx.projectRoot, ctx.workspaceRoot);
  if (!(await ensureProjectInitialized(ctx, subcmd))) {
    return false;
  }

  // Nie blokuj zawsze — ale pokaż ostrzeżenie. Część komend może działać bez dockera, część nie.
  const d = await dockerDoctor(ctx.projectRoot);
  if (!d.ok && d.hint) {
    vscode.window.showWarningMessage("Pwrforge: " + d.hint);
  }

  runInTerminal(pwrforgeCmd(ctx.sharedEnvRoot, subcmd, args), ctx.projectRoot);
  return true;
}

async function runPwrforgeNew(ctx: ProjectContext) {
  await ensureVenv(ctx.sharedEnvRoot, ctx.projectRoot, ctx.workspaceRoot);

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
  args.push("--base-dir", path.dirname(ctx.projectRoot));
  args.push(projectName.trim());

  runInTerminal(pwrforgeCmd(ctx.sharedEnvRoot, "new", args), ctx.projectRoot);
}

async function computeStatus(ctx: ProjectContext | undefined): Promise<Status> {
  if (!ctx) {
    return {
      activeProjectName: undefined,
      venvOk: false,
      python312Ok: false,
      dockerOk: false,
      dockerHint: "Select an active project first."
    };
  }

  const py = venvPython(ctx.sharedEnvRoot);
  const venvOk = exists(py);

  const py312 = await execCheck("python3.12 --version", ctx.projectRoot);
  const python312Ok = py312.ok;

  const d = await dockerDoctor(ctx.projectRoot);
  return {
    activeProjectName: projectName(ctx.projectRoot),
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

class SectionItem extends vscode.TreeItem {
  constructor(public readonly section: "environment" | "actions", label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
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

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const root = workspaceRoot();
    if (!root) {
      return [new ActionItem("Open a workspace folder", "No folder opened")];
    }

    const ctx = await resolveProjectContext(this.context, false, false);
    this.status = await computeStatus(ctx);

    if (!element) {
      return [new SectionItem("environment", "Environment"), new SectionItem("actions", "Actions")];
    }

    if (element instanceof SectionItem && element.section === "environment") {
      if (!ctx || !this.status.activeProjectName) {
        return [new ActionItem("⚠️ active project not selected", "Run: Pwrforge: Select Active Project", "pwrforge.selectProject")];
      }
      return [
        new ActionItem(`📁 project: ${this.status.activeProjectName}`, `Shared venv: ${ctx.sharedEnvRoot}/.venv`, "pwrforge.selectProject"),
        new ActionItem(
          this.status.venvOk ? "✅ .venv" : "⚠️ .venv missing",
          this.status.venvOk ? `Shared env ready in ${ctx.sharedEnvRoot}/.venv` : "Run: Pwrforge: Setup",
          this.status.venvOk ? undefined : "pwrforge.setup"
        ),
        new ActionItem(
          this.status.python312Ok ? "✅ python3.12" : "⚠️ python3.12 missing",
          this.status.python312Ok ? "Available in PATH" : "Install Python 3.12",
          undefined
        ),
        new ActionItem(
          this.status.dockerOk ? "✅ docker" : "⚠️ docker issue",
          this.status.dockerOk ? "Docker OK" : (this.status.dockerHint ?? "Check docker"),
          "pwrforge.dockerDoctor"
        )
      ];
    }

    if (element instanceof SectionItem && element.section === "actions") {
      if (!ctx) {
        return [new ActionItem("Select active project", "Choose project subfolder first", "pwrforge.selectProject")];
      }
      return [
        new ActionItem("Build", "pwrforge build", "pwrforge.build"),
        new ActionItem("Test", "pwrforge test", "pwrforge.test"),
        new ActionItem("Check", "pwrforge check", "pwrforge.check"),
        new ActionItem("Fix", "pwrforge fix", "pwrforge.fix"),
        new ActionItem("More…", "choose other commands", "pwrforge.more")
      ];
    }

    return [];
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
        pwrforgeTerminalCwd = undefined;
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

  async function getCtx(forcePick = false): Promise<ProjectContext | undefined> {
    return resolveProjectContext(context, forcePick, true);
  }

  async function updateStatusBar() {
    const root = workspaceRoot();
    if (!root) {
      statusBar.text = "Pwrforge: no workspace";
      return;
    }
    const ctx = await resolveProjectContext(context, false, false);
    const s = await computeStatus(ctx);
    const project = s.activeProjectName ? `@${s.activeProjectName}` : "@none";
    const v = s.venvOk ? "venv✓" : "venv!";
    const d = s.dockerOk ? "docker✓" : "docker!";
    statusBar.text = `Pwrforge ${project}: ${v} ${d}`;
    if (!s.dockerOk && s.dockerHint) {
      statusBar.tooltip = s.dockerHint;
    } else {
      statusBar.tooltip = s.activeProjectName
        ? `Active project: ${s.activeProjectName}`
        : "Use 'Pwrforge: Select Active Project'";
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pwrforge.refresh", async () => {
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.selectProject", async () => {
      const ctx = await getCtx(true);
      if (!ctx) {
        return;
      }
      vscode.window.showInformationMessage(`Pwrforge: active project set to ${projectName(ctx.projectRoot)}.`);
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.setup", async () => {
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      await ensureVenv(ctx.sharedEnvRoot, ctx.projectRoot, ctx.workspaceRoot);
      const dockerOk = await ensureDocker(ctx.projectRoot);
      if (dockerOk) {
        vscode.window.showInformationMessage("Pwrforge: setup OK (.venv + docker).");
      } else {
        vscode.window.showWarningMessage("Pwrforge: .venv ready. Docker still needs attention.");
      }
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.dockerDoctor", async () => {
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      const d = await dockerDoctor(ctx.projectRoot);
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
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      await runPwrforge(ctx, "build");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.test", async () => {
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      await runPwrforge(ctx, "test");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.check", async () => {
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      await runPwrforge(ctx, "check");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.fix", async () => {
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      await runPwrforge(ctx, "fix");
      provider.refresh();
      await updateStatusBar();
    }),

    vscode.commands.registerCommand("pwrforge.clean", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "clean");
      }
    }),
    vscode.commands.registerCommand("pwrforge.run", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "run");
      }
    }),
    vscode.commands.registerCommand("pwrforge.debug", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "debug");
      }
    }),
    vscode.commands.registerCommand("pwrforge.doc", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "doc");
      }
    }),
    vscode.commands.registerCommand("pwrforge.flash", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "flash");
      }
    }),
    vscode.commands.registerCommand("pwrforge.monitor", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "monitor");
      }
    }),
    vscode.commands.registerCommand("pwrforge.update", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "update");
      }
    }),
    vscode.commands.registerCommand("pwrforge.gen", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "gen");
      }
    }),
    vscode.commands.registerCommand("pwrforge.docker", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "docker");
      }
    }),
    vscode.commands.registerCommand("pwrforge.publish", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "publish");
      }
    }),
    vscode.commands.registerCommand("pwrforge.licenseCheck", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "license-check");
      }
    }),
    vscode.commands.registerCommand("pwrforge.new", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforgeNew(ctx);
      }
    }),
    vscode.commands.registerCommand("pwrforge.version", async () => {
      const ctx = await getCtx();
      if (ctx) {
        await runPwrforge(ctx, "version");
      }
    }),

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
      const ctx = await getCtx();
      if (!ctx) {
        return;
      }
      if (pick.label === "new") {
        await runPwrforgeNew(ctx);
      } else {
        await runPwrforge(ctx, pick.label);
      }
      provider.refresh();
      await updateStatusBar();
    })
  );

  // initial refresh
  void updateStatusBar();
}

export function deactivate() {}
