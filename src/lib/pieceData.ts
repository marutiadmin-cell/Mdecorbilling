/**
 * Everything the by-length sizes are replayed from (lib/pieces.ts), read
 * from the live repositories — the one place screens get it, so no screen
 * can forget a kind of document and show different sizes from another.
 */
import type { PieceData } from "@/lib/pieces";
import {
  StockAdjustmentRepo,
  PieceSortRepo,
  ProductionRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
} from "@/repositories";

export const pieceDataFromRepos = (): PieceData => ({
  stockAdjustments: StockAdjustmentRepo.all(),
  pieceSorts: PieceSortRepo.all(),
  productions: ProductionRepo.all(),
  sales: SalesRepo.all(),
  purchases: PurchaseRepo.all(),
  saleReturns: SaleReturnRepo.all(),
  purchaseReturns: PurchaseReturnRepo.all(),
});
