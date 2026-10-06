import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import { toast } from "sonner";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Receipt,
  Package,
  BarChart3,
  CloudUpload,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";

export const Route = createFileRoute("/login")({ component: LoginPage });

function friendlyAuthError(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password. Please try again.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "No internet connection. Check your network and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your administrator.";
    default:
      return "Sign in failed. Please try again.";
  }
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Please enter your email address.");
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Redirect is handled by the auth gate in __root
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      setError(friendlyAuthError(code));
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    if (!email.trim()) {
      setError("Enter your email above first, then click Forgot password.");
      emailRef.current?.focus();
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      toast.success(`Password reset link sent to ${email.trim()}`);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      setError(friendlyAuthError(code));
    }
  };

  const inputClass =
    "w-full h-12 short:h-11 border border-input rounded-xl bg-card text-[14px] outline-none transition " +
    "placeholder:text-muted-foreground/60 hover:border-primary/40 " +
    "focus:border-primary focus:ring-4 focus:ring-primary/10 " +
    // Browser autofill paints its own pale blue over the field; keep the card colour.
    "autofill:shadow-[inset_0_0_0_1000px_var(--color-card)]";

  return (
    // Exactly one screen tall: html/body never scroll in this app (see
    // styles.css), so anything taller than the window would simply be cut
    // off. The form side scrolls on its own if it ever has to.
    <div className="h-dvh w-full flex overflow-hidden bg-background">
      {/* ── Brand panel ─────────────────────────────────────────────────
          The logo's three overlapping diamonds, echoed large and soft behind
          the content, on the wordmark's own indigo. The logo itself sits on a
          white card — white is what it was drawn for. */}
      <div className="hidden lg:flex h-full relative overflow-hidden w-[46%] bg-gradient-brand text-brand-foreground flex-col justify-between gap-8 p-10 xl:p-14 short:gap-5 short:py-8 short:xl:py-8 tiny:gap-4 tiny:py-6 tiny:xl:py-6">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div
            className="absolute -top-24 right-24 h-72 w-72 rotate-45 rounded-[2.5rem] opacity-25"
            style={{ background: LOGO.amber }}
          />
          <div
            className="absolute top-32 -right-28 h-80 w-80 rotate-45 rounded-[2.5rem] opacity-20"
            style={{ background: LOGO.green }}
          />
          <div
            className="absolute -bottom-36 -left-24 h-96 w-96 rotate-45 rounded-[3rem] opacity-20"
            style={{ background: LOGO.red }}
          />
          <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:22px_22px]" />
        </div>

        {/* The whole logo, wordmark and all — it carries the name itself. */}
        <div className="relative">
          <div className="h-[150px] w-[150px] xl:h-[168px] xl:w-[168px] short:h-[112px] short:w-[112px] short:xl:h-[112px] short:xl:w-[112px] tiny:h-[84px] tiny:w-[84px] tiny:xl:h-[84px] tiny:xl:w-[84px] rounded-[2rem] short:rounded-3xl tiny:rounded-2xl bg-white p-3.5 short:p-2.5 tiny:p-1.5 shadow-2xl shadow-black/30 ring-1 ring-white/60">
            <img src="/mdecor-logo.png" alt={APP_NAME} className="h-full w-full object-contain" />
          </div>
        </div>

        <div className="relative max-w-lg">
          <span className="tiny:hidden inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11.5px] font-medium ring-1 ring-white/20 backdrop-blur">
            <LogoDots /> Billing &amp; inventory
          </span>
          <h1 className="mt-4 text-[34px] xl:text-[42px] short:mt-3 short:text-[30px] short:xl:text-[34px] tiny:mt-0 tiny:text-[26px] tiny:xl:text-[28px] font-extrabold leading-[1.1] tracking-tight">
            Every sofa, curtain &amp; mattress — billed in seconds.
          </h1>
          <p className="mt-4 short:mt-3 tiny:hidden text-white/75 text-[15px] short:text-[14px] leading-relaxed">
            GST invoices, stock of fabric, foam and finished goods, payments and profit — all on one
            screen, safely backed up in the cloud.
          </p>
          <div className="mt-8 short:mt-5 tiny:mt-4 grid grid-cols-2 gap-3 short:gap-2.5">
            <Feature
              icon={Receipt}
              color={LOGO.red}
              title="GST invoices"
              desc="Party & item created right from the bill"
            />
            <Feature
              icon={Package}
              color={LOGO.amber}
              title="Live stock"
              desc="Every sale, purchase & return counted"
            />
            <Feature
              icon={BarChart3}
              color={LOGO.green}
              title="Profit & ledgers"
              desc="P&L and GST reports always in sync"
            />
            <Feature
              icon={CloudUpload}
              color="#ffffff"
              title="Cloud backup"
              desc="Safe even if this computer fails"
            />
          </div>
        </div>

        <div className="relative flex items-center justify-between text-[12px] text-white/60">
          <span>Mfg. of Exclusive Sofa, Curtain and Mattress</span>
          <LogoBar className="w-24" />
        </div>
      </div>

      {/* ── Login form ──────────────────────────────────────────────── */}
      <div className="relative flex-1 h-full overflow-y-auto bg-[radial-gradient(ellipse_at_top_right,var(--color-primary-soft),transparent_60%)]">
        <div className="min-h-full flex items-center justify-center p-5 sm:p-8 tiny:sm:py-5">
          <div className="w-full max-w-[420px]">
            {/* Phone / tablet: no brand panel, so the full logo leads the page. */}
            <div className="lg:hidden flex justify-center mb-6">
              <div className="h-36 w-36 rounded-[2rem] bg-white p-3 shadow-elevated ring-1 ring-border">
                <img
                  src="/mdecor-logo.png"
                  alt={APP_NAME}
                  className="h-full w-full object-contain"
                />
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border bg-card shadow-elevated">
              <LogoBar className="h-1 w-full" />
              <div className="p-7 sm:p-9 short:sm:p-7 tiny:sm:p-6">
                <img
                  src="/mdecor-mark.png"
                  alt=""
                  className="hidden lg:block short:lg:hidden h-11 w-auto object-contain mb-5"
                />
                <h2 className="text-[26px] tiny:text-[23px] font-extrabold tracking-tight">
                  Welcome back
                </h2>
                <p className="text-sm text-muted-foreground mt-1 mb-7 short:mb-5">
                  Sign in to your {APP_NAME} workspace
                </p>

                {error && (
                  <div className="mb-5 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <form onSubmit={submit} className="space-y-5 short:space-y-4">
                  <label className="block">
                    <span className="text-[13px] font-semibold text-foreground">Email address</span>
                    <div className="mt-2 relative">
                      <Mail className="h-4 w-4 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        ref={emailRef}
                        type="email"
                        autoComplete="email"
                        autoFocus
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@business.com"
                        className={`${inputClass} pl-11 pr-3`}
                      />
                    </div>
                  </label>

                  <label className="block">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-semibold text-foreground">Password</span>
                      <button
                        type="button"
                        onClick={forgotPassword}
                        className="text-[12px] text-primary hover:underline font-semibold"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="mt-2 relative">
                      <Lock className="h-4 w-4 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type={showPass ? "text" : "password"}
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        className={`${inputClass} pl-11 pr-12`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPass((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition"
                        title={showPass ? "Hide password" : "Show password"}
                      >
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </label>

                  <button
                    type="submit"
                    disabled={loading}
                    className="group w-full h-12 short:h-11 rounded-xl bg-gradient-primary text-primary-foreground font-semibold text-[14.5px] shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:brightness-110 active:scale-[0.99] transition disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                      </>
                    ) : (
                      <>
                        Sign In
                        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>

            <p className="mt-6 short:mt-4 flex items-center justify-center gap-1.5 text-center text-[12px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              Access is by invitation only. Contact your administrator for an account.
            </p>
            <p className="mt-2 text-center text-[10px] text-muted-foreground/60 tabular-nums">
              Version {APP_VERSION}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The mark's three colours, sampled off the logo. */
const LOGO = { red: "#F94A3A", amber: "#F9AB2D", green: "#30CE0F" };

/** A thin red / amber / green rule — the logo's diamonds, in order. */
function LogoBar({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`flex h-1 overflow-hidden rounded-full ${className}`}>
      <span className="flex-1" style={{ background: LOGO.red }} />
      <span className="flex-1" style={{ background: LOGO.amber }} />
      <span className="flex-1" style={{ background: LOGO.green }} />
    </div>
  );
}

function LogoDots() {
  return (
    <span aria-hidden className="flex -space-x-0.5">
      {[LOGO.red, LOGO.amber, LOGO.green].map((c) => (
        <span key={c} className="h-2 w-2 rotate-45 rounded-[2px]" style={{ background: c }} />
      ))}
    </span>
  );
}

function Feature({
  icon: Icon,
  color,
  title,
  desc,
}: {
  icon: typeof Receipt;
  color: string;
  title: string;
  desc: string;
}) {
  return (
    // On short screens the card collapses to one row — icon and title only.
    <div className="rounded-2xl bg-white/[0.07] p-4 short:p-3 short:flex short:items-center short:gap-3 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/[0.11]">
      <div
        className="h-9 w-9 short:h-8 short:w-8 shrink-0 rounded-xl flex items-center justify-center"
        style={{ background: `${color}2e`, color }}
      >
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div>
        <p className="mt-3 short:mt-0 font-semibold text-[14px]">{title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-white/65 short:hidden">{desc}</p>
      </div>
    </div>
  );
}
