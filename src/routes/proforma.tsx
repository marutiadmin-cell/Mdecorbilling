import { createFileRoute } from "@tanstack/react-router";
import { EstimatesPage } from "@/components/EstimatesPage";

export const Route = createFileRoute("/proforma")({
  component: () => <EstimatesPage kind="proforma" />,
});
