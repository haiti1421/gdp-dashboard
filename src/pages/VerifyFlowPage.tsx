import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Image as ImageIcon,
  Loader2,
  AlertTriangle,
  Inbox,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  formatCurrency,
  formatRelativeTime,
  paymentMethodLabel,
} from "@/lib/utils";
import type { PaymentProof, Circle } from "@/lib/types";

export default function VerifyFlowPage() {
  const [params] = useSearchParams();
  const { user } = useAuth();
  const ledgerId = params.get("ledger");

  const [circle, setCircle] = useState<Circle | null>(null);
  const [proofs, setProofs] = useState<PaymentProof[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!user) return;

    let query = supabase
      .from("payment_proofs")
      .select("*")
      .eq("recipient_user_id", user.id)
      .eq("status", "PENDING")
      .order("created_at", { ascending: true });

    if (ledgerId) {
      query = query.eq("ledger_id", ledgerId);

      const { data: l } = await supabase
        .from("ledgers")
        .select("*, circles(*)")
        .eq("id", ledgerId)
        .single();

      if (l && l.circles) {
        setCircle(l.circles as unknown as Circle);
      }
    }

    const { data } = await query;
    setProofs(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();

    // Realtime: auto-refresh when a payer submits a new proof
    if (!user) return;

    const filter = ledgerId
      ? `ledger_id=eq.${ledgerId}`
      : `recipient_user_id=eq.${user.id}`;

    const channel = supabase
      .channel("verify-proofs")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "payment_proofs",
          filter,
        },
        () => {
          load();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, ledgerId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-susu-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6">
      <div>
        {circle && (
          <Link
            to={`/circle/${circle.id}`}
            className="mb-3 inline-flex items-center gap-1 text-sm text-coal-400 hover:text-coal-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {circle.name}
          </Link>
        )}
        <h1 className="font-display text-2xl font-semibold text-coal-50">
          Verify Payments
        </h1>
        <p className="mt-1 text-sm text-coal-400">
          {proofs.length === 0
            ? "No pending payments to verify"
            : `${proofs.length} payment${proofs.length > 1 ? "s" : ""} awaiting your confirmation`}
        </p>
      </div>

      {proofs.length === 0 && (
        <div className="card text-center py-12 space-y-3">
          <Inbox className="mx-auto h-10 w-10 text-coal-600" />
          <p className="text-coal-400">All caught up.</p>
          <Link to="/" className="btn-secondary inline-flex">
            Back to Dashboard
          </Link>
        </div>
      )}

      <div className="space-y-4">
        {proofs.map((proof) => (
          <ProofCard key={proof.id} proof={proof} onUpdate={load} />
        ))}
      </div>
    </div>
  );
}

function ProofCard({
  proof,
  onUpdate,
}: {
  proof: PaymentProof;
  onUpdate: () => void;
}) {
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payerName, setPayerName] = useState<string | null>(null);

  // Load signed receipt URL
  useEffect(() => {
    if (!proof.receipt_storage_path) return;

    supabase.storage
      .from("receipts")
      .createSignedUrl(proof.receipt_storage_path, 3600)
      .then(({ data }) => {
        if (data?.signedUrl) setReceiptUrl(data.signedUrl);
      });
  }, [proof.receipt_storage_path]);

  // Load payer display name
  useEffect(() => {
    supabase
      .from("profiles")
      .select("display_name")
      .eq("id", proof.payer_user_id)
      .single()
      .then(({ data }) => {
        setPayerName(data?.display_name ?? null);
      });
  }, [proof.payer_user_id]);

  const handleVerify = async () => {
    setConfirming(true);
    setError(null);
    try {
      // Single RPC handles:
      // - auth.uid() check (must be the recipient)
      // - Status validation (must be PENDING)
      // - Proof → VERIFIED
      // - Atomic ledger increment
      // - Auto-complete if pot is full
      const { error: rpcErr } = await supabase.rpc("verify_payment_proof", {
        p_proof_id: proof.id,
        p_recipient_note: null,
      });

      if (rpcErr) {
        throw new Error(rpcErr.message || "Verification failed");
      }

      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify");
    } finally {
      setConfirming(false);
    }
  };

  const handleDispute = async () => {
    if (disputeReason.length < 10) {
      setError("Please provide a reason (at least 10 characters).");
      return;
    }

    setDisputing(true);
    setError(null);
    try {
      // RPC handles auth + status validation + ledger flagging
      const { error: rpcErr } = await supabase.rpc("dispute_payment_proof", {
        p_proof_id: proof.id,
        p_reason: disputeReason,
      });

      if (rpcErr) {
        throw new Error(rpcErr.message || "Dispute failed");
      }

      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dispute");
    } finally {
      setDisputing(false);
    }
  };

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-coal-100">
            {formatCurrency(proof.amount)}
            {payerName && (
              <span className="ml-1.5 font-normal text-coal-400">
                from {payerName}
              </span>
            )}
          </p>
          <p className="text-xs text-coal-500">
            via {paymentMethodLabel(proof.payment_method)} ·{" "}
            {formatRelativeTime(proof.created_at)}
          </p>
        </div>
        <span className="badge-pending">Pending</span>
      </div>

      {proof.payer_note && (
        <p className="rounded-lg bg-coal-800 px-3 py-2 text-sm text-coal-300 italic">
          "{proof.payer_note}"
        </p>
      )}

      {receiptUrl && (
        <div>
          <button
            onClick={() => setShowReceipt(!showReceipt)}
            className="inline-flex items-center gap-1.5 text-sm text-susu-400 hover:text-susu-300 transition-colors"
          >
            <ImageIcon className="h-4 w-4" />
            {showReceipt ? "Hide receipt" : "View receipt"}
          </button>
          {showReceipt && (
            <div className="mt-2 overflow-hidden rounded-xl border border-coal-700">
              <img
                src={receiptUrl}
                alt="Payment receipt"
                className="max-h-72 w-full object-contain bg-coal-800"
              />
            </div>
          )}
        </div>
      )}

      {!showDisputeForm ? (
        <div className="flex gap-3">
          <button
            onClick={handleVerify}
            className="btn-success flex-1"
            disabled={confirming}
          >
            {confirming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Confirm
          </button>
          <button
            onClick={() => setShowDisputeForm(true)}
            className="btn-secondary flex-1"
          >
            <AlertTriangle className="h-4 w-4" />
            Dispute
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            className="input-field resize-none"
            rows={3}
            placeholder="Describe why you're disputing this payment (min 10 characters)..."
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
          />
          <div className="flex gap-3">
            <button
              onClick={handleDispute}
              className="flex-1 btn-primary !bg-red-600 hover:!bg-red-500"
              disabled={disputing || disputeReason.length < 10}
            >
              {disputing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              Submit Dispute
            </button>
            <button
              onClick={() => {
                setShowDisputeForm(false);
                setDisputeReason("");
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
