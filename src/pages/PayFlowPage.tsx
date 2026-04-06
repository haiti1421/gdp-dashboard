import { useEffect, useState, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Upload,
  Camera,
  CheckCircle2,
  Loader2,
  Copy,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  formatCurrency,
  generateDeepLink,
  paymentMethodLabel,
} from "@/lib/utils";
import type {
  Circle,
  Ledger,
  Membership,
  PaymentMethod,
} from "@/lib/types";

type Step = "choose-method" | "pay-external" | "upload-receipt" | "done";

const PAYMENT_METHODS: { value: PaymentMethod; label: string; icon: string }[] = [
  { value: "CASHAPP", label: "Cash App", icon: "💵" },
  { value: "VENMO", label: "Venmo", icon: "🔵" },
  { value: "ZELLE", label: "Zelle", icon: "⚡" },
];

export default function PayFlowPage() {
  const [params] = useSearchParams();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const circleId = params.get("circle");
  const ledgerId = params.get("ledger");

  const [step, setStep] = useState<Step>("choose-method");
  const [circle, setCircle] = useState<Circle | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [recipientMembership, setRecipientMembership] = useState<Membership | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const [deepLinkUrl, setDeepLinkUrl] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!circleId || !ledgerId) return;

    async function load() {
      const { data: c } = await supabase
        .from("circles")
        .select("*")
        .eq("id", circleId!)
        .single();

      const { data: l } = await supabase
        .from("ledgers")
        .select("*")
        .eq("id", ledgerId!)
        .single();

      if (c && l) {
        setCircle(c);
        setLedger(l);

        const { data: mem } = await supabase
          .from("memberships")
          .select("*")
          .eq("circle_id", circleId!)
          .eq("user_id", l.recipient_user_id)
          .single();

        setRecipientMembership(mem);
      }
      setLoading(false);
    }

    load();
  }, [circleId, ledgerId]);

  const handleMethodSelect = (method: PaymentMethod) => {
    setSelectedMethod(method);
    setError(null);

    if (!circle || !ledger || !recipientMembership) return;

    const handle =
      method === "CASHAPP"
        ? recipientMembership.cashapp_handle
        : method === "VENMO"
          ? recipientMembership.venmo_handle
          : recipientMembership.zelle_identifier;

    if (!handle) {
      setError(
        `The recipient hasn't set up their ${paymentMethodLabel(method)} handle yet. Ask them to update their profile in the Account tab.`
      );
      return;
    }

    const link = generateDeepLink(
      method,
      handle,
      circle.contribution_amount,
      `SusuCircle – ${circle.name} (Period ${ledger.period_number})`
    );

    setDeepLinkUrl(link);
    setStep("pay-external");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = [
      "image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf",
    ];
    const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf"];
    const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");

    // Some mobile browsers return empty file.type — fall back to extension
    const typeOk = file.type ? allowedTypes.includes(file.type) : allowedExts.includes(ext);
    if (!typeOk) {
      setError("Please upload an image (JPG, PNG, WebP) or PDF.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("File must be under 10 MB.");
      return;
    }

    setReceiptFile(file);
    setError(null);

    const isImage = file.type
      ? file.type.startsWith("image/")
      : [".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(ext);

    if (isImage) {
      const reader = new FileReader();
      reader.onload = (ev) => setReceiptPreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setReceiptPreview(null);
    }
  };

  const handleSubmit = async () => {
    if (!receiptFile || !ledger || !circle || !user || !selectedMethod) return;

    setUploading(true);
    setError(null);

    try {
      // 1. Upload receipt to Supabase Storage
      const uniqueId = crypto.randomUUID().slice(0, 12);
      const ext = receiptFile.name.split(".").pop() || "jpg";
      const storagePath = `${user.id}/${ledger.id}/${uniqueId}.${ext}`;

      // Resolve content type — fallback from extension if file.type is empty
      const contentType = receiptFile.type || (() => {
        const extMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          webp: "image/webp", heic: "image/heic", pdf: "application/pdf",
        };
        return extMap[ext.toLowerCase()] || "application/octet-stream";
      })();

      const { error: uploadErr } = await supabase.storage
        .from("receipts")
        .upload(storagePath, receiptFile, {
          contentType,
        });

      if (uploadErr) {
        throw new Error(`Upload failed: ${uploadErr.message}`);
      }

      // 2. Call the transactional RPC — this handles:
      //    - Auth check (auth.uid())
      //    - Membership validation
      //    - Self-pay prevention
      //    - Idempotency (SHA-256 unique constraint)
      //    - Proof INSERT + ledger OPEN→COLLECTING
      //    All in one atomic transaction.
      const { error: rpcErr } = await supabase.rpc(
        "submit_payment_proof_tx",
        {
          p_ledger_id: ledger.id,
          p_payment_method: selectedMethod,
          p_receipt_path: storagePath,
          p_payer_note: note || null,
          p_metadata: {
            deep_link: deepLinkUrl,
            original_filename: receiptFile.name,
            content_type: contentType,
          },
        }
      );

      if (rpcErr) {
        // Clean up orphaned receipt from storage
        await supabase.storage.from("receipts").remove([storagePath]);

        // Parse Postgres exception messages into user-friendly errors
        const msg = rpcErr.message || "";
        if (msg.includes("already submitted") || msg.includes("idempotency")) {
          throw new Error("You've already submitted a receipt for this period.");
        }
        if (msg.includes("not accepting")) {
          throw new Error("This period is no longer accepting payments.");
        }
        if (msg.includes("not an active member")) {
          throw new Error("You're not an active member of this circle.");
        }
        if (msg.includes("does not pay into")) {
          throw new Error("The pot recipient doesn't pay into their own period.");
        }
        throw new Error(msg || "Failed to submit proof.");
      }

      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-susu-500 border-t-transparent" />
      </div>
    );
  }

  if (!circle || !ledger) {
    return (
      <div className="animate-fade-up py-20 text-center">
        <p className="text-coal-400">Select a circle to pay into.</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">
          Go to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6">
      <div>
        <Link
          to={`/circle/${circle.id}`}
          className="mb-3 inline-flex items-center gap-1 text-sm text-coal-400 hover:text-coal-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {circle.name}
        </Link>
        <h1 className="font-display text-2xl font-semibold text-coal-50">
          Submit Payment
        </h1>
        <p className="mt-1 text-sm text-coal-400">
          Period {ledger.period_number} ·{" "}
          {formatCurrency(circle.contribution_amount)}
        </p>
      </div>

      {/* Step: Choose Method */}
      {step === "choose-method" && (
        <div className="space-y-3">
          <p className="text-sm text-coal-300">How are you paying?</p>
          {PAYMENT_METHODS.map(({ value, label, icon }) => (
            <button
              key={value}
              onClick={() => handleMethodSelect(value)}
              className="card-interactive flex w-full items-center gap-4 text-left"
            >
              <span className="text-2xl">{icon}</span>
              <div>
                <p className="font-medium text-coal-100">{label}</p>
                <p className="text-xs text-coal-500">
                  {value === "CASHAPP" && (recipientMembership?.cashapp_handle || "No handle set")}
                  {value === "VENMO" && (recipientMembership?.venmo_handle || "No handle set")}
                  {value === "ZELLE" && (recipientMembership?.zelle_identifier || "No identifier set")}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Step: Pay External */}
      {step === "pay-external" && deepLinkUrl && (
        <div className="space-y-4">
          <div className="card space-y-4">
            {selectedMethod === "ZELLE" ? (
              <>
                <p className="text-sm text-coal-300">
                  Zelle doesn't support direct links. Send{" "}
                  <span className="font-medium text-coal-100">
                    {formatCurrency(circle.contribution_amount)}
                  </span>{" "}
                  to the address below, then come back to upload your receipt.
                </p>
                <div className="rounded-lg bg-coal-800 p-3 flex items-center justify-between gap-2">
                  <p className="text-sm text-coal-200 font-mono truncate">
                    {recipientMembership?.zelle_identifier}
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        recipientMembership?.zelle_identifier ?? ""
                      );
                    }}
                    className="flex-shrink-0 rounded-lg bg-coal-700 p-2 text-coal-300 hover:text-coal-100 transition-colors"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-coal-300">
                  Tap below to open {paymentMethodLabel(selectedMethod!)}.
                  After paying, come back and upload your receipt.
                </p>
                <a
                  href={deepLinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary w-full"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open {paymentMethodLabel(selectedMethod!)}
                </a>
              </>
            )}
          </div>
          <button
            onClick={() => setStep("upload-receipt")}
            className="btn-secondary w-full"
          >
            I've paid — upload receipt
          </button>
        </div>
      )}

      {/* Step: Upload Receipt */}
      {step === "upload-receipt" && (
        <div className="space-y-4">
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`card cursor-pointer border-dashed text-center transition-colors ${
              receiptFile
                ? "border-sage-600"
                : "border-coal-600 hover:border-coal-500"
            }`}
          >
            {/* NO capture attribute — let the user choose camera OR gallery */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileChange}
              className="hidden"
            />

            {receiptPreview ? (
              <div className="space-y-3">
                <img
                  src={receiptPreview}
                  alt="Receipt preview"
                  className="mx-auto max-h-48 rounded-lg object-contain"
                />
                <p className="text-sm text-sage-400">
                  <CheckCircle2 className="mr-1 inline h-4 w-4" />
                  {receiptFile?.name}
                </p>
                <p className="text-xs text-coal-500">Tap to change</p>
              </div>
            ) : receiptFile ? (
              <div className="space-y-2 py-4">
                <CheckCircle2 className="mx-auto h-8 w-8 text-sage-400" />
                <p className="text-sm text-coal-200">{receiptFile.name}</p>
                <p className="text-xs text-coal-500">Tap to change</p>
              </div>
            ) : (
              <div className="space-y-2 py-8">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-coal-800">
                  <Camera className="h-6 w-6 text-coal-400" />
                </div>
                <p className="text-sm text-coal-300">
                  Tap to choose a screenshot or take a photo
                </p>
                <p className="text-xs text-coal-500">
                  Your payment confirmation from {paymentMethodLabel(selectedMethod!)}
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm text-coal-400">
              Note (optional)
            </label>
            <input
              type="text"
              className="input-field"
              placeholder="e.g. Sent from backup account"
              maxLength={280}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <button
            onClick={handleSubmit}
            className="btn-primary w-full"
            disabled={!receiptFile || uploading}
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Submit Proof
              </>
            )}
          </button>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <div className="card text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sage-500/15">
            <CheckCircle2 className="h-8 w-8 text-sage-400" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold text-coal-50">
              Proof Submitted
            </h2>
            <p className="mt-1 text-sm text-coal-400">
              The recipient will review and confirm your payment.
            </p>
          </div>
          <Link to={`/circle/${circle.id}`} className="btn-secondary w-full">
            Back to Circle
          </Link>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
