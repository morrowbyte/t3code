import * as NodeZlib from "node:zlib";

// The elevated process receives code and the approved script in its command line, never from a
// writable file. The job owns the suspended worker before it runs.
const source = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class T3Supervisor {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int size; public string reserved, desktop, title; public int x,y,xsize,ysize,xchars,ychars,fill,flags; public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIEX { public SI startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess, perJob; public uint flags; public UIntPtr minWorking, maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC basic; public IO io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA sa, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SA sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SIEX si, out PI pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr h) { if (h != IntPtr.Zero && h != new IntPtr(-1)) CloseHandle(h); h=IntPtr.Zero; }
  static string Drain(IntPtr handle) {
    using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read)) {
      var kept = new MemoryStream(); var buf = new byte[8192]; int n; bool truncated=false;
      while ((n=stream.Read(buf,0,buf.Length))>0) { int take=Math.Min(n, 65536-(int)kept.Length); if (take>0) kept.Write(buf,0,take); if (take<n) truncated=true; }
      return Convert.ToBase64String(kept.ToArray()) + (truncated ? ":truncated" : "");
    }
  }
  static bool Cancelled(string control) {
    if (File.ReadAllText(control, Encoding.ASCII)!="run") throw new Exception("stop channel invalid");
    try { File.GetAttributes(control+".stop"); return true; } catch (FileNotFoundException) { return false; }
  }
  static void WaitEmpty(IntPtr job) {
    for (int i=0;i<250;i++) { ACCOUNTING a; Check(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)); if (a.active==0) return; System.Threading.Thread.Sleep(20); }
    throw new Exception("job cleanup not confirmed");
  }
  public static string Run(int parentId, long parentCreation, int serverId, long serverCreation, string cwd, string script, int timeout, string control) {
    IntPtr parent=IntPtr.Zero, server=IntPtr.Zero, job=IntPtr.Zero, outRead=IntPtr.Zero, outWrite=IntPtr.Zero, errRead=IntPtr.Zero, errWrite=IntPtr.Zero, nul=IntPtr.Zero;
    PI pi=new PI(); IntPtr attributes=IntPtr.Zero, jobList=IntPtr.Zero; bool initialized=false;
    try {
      parent=OpenProcess(0x101000, false, parentId); Check(parent!=IntPtr.Zero);
      long created, exited, kernel, user; Check(GetProcessTimes(parent, out created, out exited, out kernel, out user));
      Check(created==parentCreation && WaitForSingleObject(parent,0)==258);
      server=OpenProcess(0x101000, false, serverId); Check(server!=IntPtr.Zero);
      Check(GetProcessTimes(server, out created, out exited, out kernel, out user));
      Check(created==serverCreation && WaitForSingleObject(server,0)==258);
      if (Cancelled(control)) return "cancelled\n\n\n";
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new EXTENDED(); limits.basic.flags=0x2000;
      int size=Marshal.SizeOf(typeof(EXTENDED)); IntPtr data=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits,data,false); Check(SetInformationJobObject(job,9,data,(uint)size)); } finally { Marshal.FreeHGlobal(data); }
      var sa=new SA(); sa.length=Marshal.SizeOf(typeof(SA)); sa.inherit=1;
      Check(CreatePipe(out outRead,out outWrite,ref sa,0)); Check(SetHandleInformation(outRead,1,0));
      Check(CreatePipe(out errRead,out errWrite,ref sa,0)); Check(SetHandleInformation(errRead,1,0));
      nul=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
      string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
      string script64=Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
      string workerCommand="[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false;$OutputEncoding=[Console]::OutputEncoding;& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"+script64+"'))))";
      string encoded=Convert.ToBase64String(Encoding.Unicode.GetBytes(workerCommand));
      IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize);
      attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize)); initialized=true;
      jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var si=new SIEX(); si.startup.size=Marshal.SizeOf(typeof(SIEX)); si.startup.flags=0x101; si.startup.show=0; si.startup.stdin=nul; si.startup.stdout=outWrite; si.startup.stderr=errWrite; si.attributes=attributes;
      // Atomic assignment avoids leaving an unowned suspended process if the supervisor dies.
      // A private hidden console permits Windows PowerShell 5 to set its output code page.
      Check(CreateProcess(exe,new StringBuilder("\""+exe+"\" -NoLogo -NoProfile -NonInteractive -EncodedCommand "+encoded),IntPtr.Zero,IntPtr.Zero,true,0x00080014,IntPtr.Zero,cwd,ref si,out pi));
      // Recheck the retained handle after UAC and before executing the payload.
      Check(WaitForSingleObject(parent,0)==258 && WaitForSingleObject(server,0)==258);
      if (Cancelled(control)) { Check(TerminateJobObject(job,1)); WaitEmpty(job); return "cancelled\n\n\n"; }
      Close(ref outWrite); Close(ref errWrite); Close(ref nul);
      IntPtr o=outRead, e=errRead; outRead=IntPtr.Zero; errRead=IntPtr.Zero;
      var stdout=Task.Run(() => Drain(o)); var stderr=Task.Run(() => Drain(e));
      Check(ResumeThread(pi.thread)!=0xffffffff);
      uint wait=258; var clock=System.Diagnostics.Stopwatch.StartNew();
      while (clock.ElapsedMilliseconds < timeout && !Cancelled(control)) {
        wait=WaitForMultipleObjects(3,new IntPtr[]{parent,server,pi.process},false,(uint)Math.Min(100,timeout-clock.ElapsedMilliseconds));
        if (wait!=258) break;
      }
      uint code=0; bool completed=wait==2 && GetExitCodeProcess(pi.process,out code);
      Check(TerminateJobObject(job,1));
      Check(WaitForSingleObject(pi.process,5000)==0);
      WaitEmpty(job);
      Close(ref job);
      // Descendants inherited the pipes; terminating the job releases their write handles.
      if (!Task.WaitAll(new Task[]{stdout,stderr},5000)) throw new Exception("output drain did not finish");
      string status=completed ? (code==0 ? "succeeded" : "failed") : (wait==258 ? "cancelled" : "unknown");
      return status+"\n"+(completed ? code.ToString() : "")+"\n"+stdout.Result+"\n"+stderr.Result;
    } finally {
      Close(ref job); Close(ref pi.thread); Close(ref pi.process); Close(ref parent); Close(ref server);
      Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite); Close(ref nul);
      if (initialized) DeleteProcThreadAttributeList(attributes); if (attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
    }
  }
}`;

const utf16 = (value: string) => Buffer.from(value, "utf16le").toString("base64");
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const workerPrefix =
  "[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false;$OutputEncoding=[Console]::OutputEncoding;& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('";
const workerSuffix = "'))))";

export function makeWindowsWrapper(
  script: string,
  cwd: string,
  timeoutMs: number,
  control = "",
  serverId = 0,
  serverCreation = "0",
): string | null {
  const compressed = NodeZlib.gzipSync(Buffer.from(source, "utf8")).toString("base64");
  const script64 = NodeZlib.gzipSync(Buffer.from(script, "utf16le")).toString("base64");
  const cwd64 = utf16(cwd);
  const prefix = `$ErrorActionPreference='Stop';$pipe=New-Object IO.Pipes.NamedPipeClientStream('.',`;
  const middle = `,[IO.Pipes.PipeDirection]::Out);$pipe.Connect(2000);try{$b=[Convert]::FromBase64String('${compressed}');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g);Add-Type -TypeDefinition $r.ReadToEnd();$result=[T3Supervisor]::Run(`;
  const suffix = `,${serverId},[long]${serverCreation},[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${cwd64}')),(DecodeScript '${script64}'),${timeoutMs},[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16(control)}')));$w=New-Object IO.StreamWriter($pipe,[Text.Encoding]::ASCII);$w.Write($result);$w.Flush()}finally{$pipe.Dispose()}`;
  const decoder = `function DecodeScript($s){$m=New-Object IO.MemoryStream(,[Convert]::FromBase64String($s));$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$d=New-Object IO.MemoryStream;$g.CopyTo($d);[Text.Encoding]::Unicode.GetString($d.ToArray())};`;
  // Leave room for the executable, pipe name, process identity and command-line quoting.
  if (
    utf16(decoder + prefix + middle + suffix).length > 30000 ||
    utf16(workerPrefix + utf16(script) + workerSuffix).length > 30000
  )
    return null;
  return String.raw`
$ErrorActionPreference='Stop'
$name='t3-privileged-'+[Guid]::NewGuid().ToString('N')
$server=New-Object IO.Pipes.NamedPipeServerStream($name,[IO.Pipes.PipeDirection]::In,1)
try {
  $exe=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'WindowsPowerShell\v1.0\powershell.exe'
  $created=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc()
  $payload=${quoted(decoder + prefix)} + "'" + $name + "'" + ${quoted(middle)} + $PID + ',' + $created + ${quoted(suffix)}
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
  try { $p=Start-Process -FilePath $exe -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -PassThru }
  catch { $errorException=$_.Exception; while ($null -ne $errorException) { if ($errorException.NativeErrorCode -eq 1223) { [Console]::Out.Write('UAC_CANCELLED'); exit 0 }; $errorException=$errorException.InnerException }; throw }
  $pending=$server.BeginWaitForConnection($null,$null)
  if (!$pending.AsyncWaitHandle.WaitOne(${timeoutMs})) { [Console]::Out.Write('NO_RESULT'); exit 0 }
  $server.EndWaitForConnection($pending)
  $reader=New-Object IO.StreamReader($server,[Text.Encoding]::ASCII)
  $response=$reader.ReadToEnd(); $p.WaitForExit(); [Console]::Out.Write($response)
} finally { $server.Dispose() }
`;
}
