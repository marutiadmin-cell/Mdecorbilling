import { createFileRoute } from "@tanstack/react-router";
import { EstimateDetail } from "@/components/EstimateDetail";

export const Route = createFileRoute("/quotations_/$id")({ component: QuotationDetail });

function QuotationDetail() {
  const { id } = Route.useParams();
  return <EstimateDetail kind="quotation" id={id} />;
}
