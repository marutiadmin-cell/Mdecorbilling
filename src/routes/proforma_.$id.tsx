import { createFileRoute } from "@tanstack/react-router";
import { EstimateDetail } from "@/components/EstimateDetail";

export const Route = createFileRoute("/proforma_/$id")({ component: ProformaDetail });

function ProformaDetail() {
  const { id } = Route.useParams();
  return <EstimateDetail kind="proforma" id={id} />;
}
