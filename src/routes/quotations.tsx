import { createFileRoute } from "@tanstack/react-router";
import { EstimatesPage } from "@/components/EstimatesPage";

export const Route = createFileRoute("/quotations")({
  component: () => <EstimatesPage kind="quotation" />,
});
