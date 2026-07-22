"use client";

/**
 * AdminLoginDialog
 *
 * Modal that asks for the admin password and posts it to /api/admin/login.
 * On success the server sets an HTTP-only signed session cookie, the dialog
 * closes, and the parent flips `isAdmin` so the rest of the admin UI (the
 * "Won History" tab, the lock button's locked state) becomes visible.
 *
 * Also exported: AdminGateButton — the small lock/unlock pill shown in the
 * header. Clicking it when logged-out opens the dialog. Clicking when logged-in
 * triggers a /api/admin/logout POST and clears admin state.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, Unlock, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface AdminLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AdminLoginDialog({
  open,
  onOpenChange,
  onSuccess,
}: AdminLoginDialogProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || !data.ok) {
        toast.error(data.error ?? `Login failed (HTTP ${r.status})`);
        return;
      }
      toast.success("Admin login successful");
      setPassword("");
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(`Login failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Admin Login
          </DialogTitle>
          <DialogDescription>
            Enter the admin password to unlock the won-parlays history view.
            This area is restricted — only the site owner should have access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="admin-password">Password</Label>
            <Input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              disabled={submitting}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !password}>
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Verifying…
                </>
              ) : (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Unlock
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface AdminGateButtonProps {
  isAdmin: boolean;
  onOpenLogin: () => void;
  onLogout: () => void;
  /** When true, the server returned that admin login is disabled (no password configured). */
  disabled?: boolean;
  className?: string;
}

/**
 * The header pill — shows lock state. When logged-out, click opens the login
 * dialog. When logged-in, click logs out.
 */
export function AdminGateButton({
  isAdmin,
  onOpenLogin,
  onLogout,
  disabled,
  className,
}: AdminGateButtonProps) {
  return (
    <Button
      type="button"
      variant={isAdmin ? "default" : "outline"}
      size="sm"
      onClick={() => {
        if (isAdmin) onLogout();
        else onOpenLogin();
      }}
      disabled={disabled}
      title={
        disabled
          ? "Admin login disabled — set ADMIN_PASSWORD env var"
          : isAdmin
            ? "Admin mode active — click to log out"
            : "Admin login"
      }
      className={cn(
        "gap-1.5 text-xs h-8",
        isAdmin
          ? "bg-violet-600 hover:bg-violet-700 text-white border-violet-600"
          : "",
        className
      )}
    >
      {disabled ? (
        <ShieldAlert className="h-3.5 w-3.5" />
      ) : isAdmin ? (
        <Unlock className="h-3.5 w-3.5" />
      ) : (
        <Lock className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">{isAdmin ? "Admin" : "Admin"}</span>
      {isAdmin && (
        <span className="hidden md:inline text-[10px] opacity-80 ml-0.5">
          (click to lock)
        </span>
      )}
    </Button>
  );
}
