import type { HardcodedHit } from './types.ts'

type Rule = [string, RegExp, string]
const ABSOLUTE: Rule[] = [
 ['HC-FORBID-RMRF-ROOT', /\brm\b(?=[^|;\n]*\s-[a-z]*r)(?=[^|;\n]*\s-[a-z]*f)[^|;\n]*\s+(?:\/["'`]*(?:[\s;|&]|$)|~\/?["'`]*\s*(?:;|\||&|$))/i,'recursive delete of root / home — absolute forbidden'],
 ['HC-FORBID-RMRF-WILDCARD', /\brm\b(?=[^|;\n]*\s-[a-z]*r)(?=[^|;\n]*\s-[a-z]*f)[^|;\n]*\s+(?:\/\*|~\/.+\*|\*\s*$)/i,'recursive wildcard mass delete'],
 ['HC-FORBID-MKFS', /\bmkfs(?:\.\w+)?\b/i,'filesystem formatting'],
 ['HC-FORBID-DD-BLKDEV', /\bdd\b[^|;\n]*\bof\s*=\s*\/dev\/(?:sd|nvme|hd|disk)/i,'direct block-device overwrite'],
 ['HC-FORBID-CHMOD-SYSROOT', /\bchmod\b[^|;\n]*-R[^|;\n]*\s+\/(?:\s|$)|\bchmod\b[^|;\n]*\s+[0-7]{3,4}\s+\/(?:etc|bin|usr|sbin|boot|root)(?:\s|$)/i,'system root permission overwrite'],
 ['HC-FORBID-FORKBOMB', /:\(\)\s*\{[^}]*:[|][^}]*\}\s*;?\s*:\s*\)\s*[|&]/i,'fork bomb'],
 ['HC-FORBID-DEV-TCP-SHELL', /\b(?:bash|sh|zsh)\b[^|;\n]*-i[^|;\n]*(?:\/dev\/(?:tcp|udp)\/|<\s*\/dev\/(?:tcp|udp)\/)/i,'interactive reverse shell'],
 ['HC-FORBID-NC-E-SHELL', /\bnc\b[^|;\n]*\s-e\b[^|;\n]*(?:\/bin\/(?:bash|sh)|sh\s|bash\b)/i,'netcat shell'],
 ['HC-FORBID-CURL-PIPE-SHELL', /\b(?:curl|wget)\b[^|;\n]*\|\s*(?:bash|sh|zsh|python)\b/i,'downloaded code execution'],
 ['HC-FORBID-REVSHELL-PY', /python[^|;\n]*-c[^|;\n]*(?:socket\.|subprocess\.|os\.system.*sh)/i,'python reverse shell'],
 ['HC-FORBID-WRITE-BLKDEV', />\s*\/dev\/(?:sd|nvme|hd|disk|sda|sdb|nvme0n)/i,'block-device write'],
 ['HC-FORBID-PRIVATE-KEY-LEAK', /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/i,'private key leak'],
]
const REVIEW: Rule[] = [
 ['HC-HR-PRIV-ESCALATION', /\b(?:sudo|su\b|runas|doas)\b/i,'privilege escalation'],
 ['HC-HR-CHMOD-SUID', /\bchmod\b[^|;\n]*[0-7]{4}\b|u\+s|g\+s/i,'SUID permission change'],
 ['HC-HR-GIT-FORCE', /\bgit\b[^|;\n]*(?:push\s+--force|push\s+-f|reset\s+--hard|clean\s+-fdx?)/i,'destructive git operation'],
 ['HC-HR-PKG-INSTALL', /\b(?:pip|pip3|conda|npm|yarn|cargo|gem)\b[^|;\n]*(?:install|i|add)\b/i,'package installation'],
 ['HC-HR-DB-DESTRUCTIVE', /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM\b)/i,'destructive database operation'],
 ['HC-HR-DELETE-NO-WHERE', /DELETE\s+FROM\s+\w+(?:\s|;|$)(?!.*\bWHERE\b)/is,'delete without where'],
 ['HC-HR-NET-EGRESS', /\b(?:curl|wget|scp|rsync|nc|netcat|ncat)\b[^|;\n]*(?:https?:\/\/|@(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9.-]+\.[a-z]{2,})/i,'network egress'],
 ['HC-HR-CRED-EXFIL', /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,})/i,'credential exfiltration'],
 ['HC-HR-WRITE-SYS-PATH', /(?:^|[\s"'`])(?:\/(?:etc|bin|usr|sbin|boot|root|proc|sys)|C:\\(?:Windows|Program Files|Users\\[^\\]+\\AppData\\Roaming))(?:[\s"'`/\\]|$)/i,'system path write'],
 ['HC-HR-CHOWN-SYS', /\bchown\b[^|;\n]*-R/i,'recursive system ownership change'],
 ['HC-HR-SYSTEMCTL-DISABLE', /\b(?:systemctl|service)\b[^|;\n]*(?:disable|mask|stop|kill)/i,'service disruption'],
 ['HC-HR-CRON-PERSIST', /\bcrontab\b|(?:\/etc\/cron(?:\.\w+)?\/)/i,'persistence via cron'],
 ['HC-HR-RM-RECURSIVE', /\brm\b[^|;\n]*-r/i,'recursive delete'],
]
function scan(rules: Rule[], text: string) { for (const [rule_id, rx, reason] of rules) { const m=rx.exec(text); if(m)return {rule_id,reason,matched:m[0]} } return null }
export interface HardcodedAudit { text:string; tool?:string; operation?:string; cwd?:string }
export function evaluateHardcoded(audit: HardcodedAudit|string): HardcodedHit|null { const r=typeof audit==='string'?{text:audit}:audit; const text=r.text || ''; if(!text)return null; const metadata = `${r.tool ?? ''} ${r.operation ?? ''} ${r.cwd ?? ''}`; const b=scan(ABSOLUTE,text); if(b)return {...b,severity:'block'}; const systemCwd = /^(?:[A-Za-z]:[\\/](?:Windows|Program Files|Users[\\/][^\\/]+[\\/]AppData[\\/]Roaming)|\/(?:etc|bin|usr|sbin|boot|root|proc|sys)(?:[\\/]|$))/i.test(r.cwd ?? ''); if ((r.tool === 'Bash' && r.operation === 'query' && systemCwd) || ((r.tool === 'Write' || r.tool === 'Edit') && systemCwd)) return {rule_id:'HC-HR-AUDIT-SYSTEM-PATH',severity:'review',reason:'operation targets an absolute/system workspace',matched:metadata}; const v=scan(REVIEW,text); return v?{...v,severity:'review'}:null }
