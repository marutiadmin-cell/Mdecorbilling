import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // ring-offset is load-bearing, not decorative: --ring and --primary are the
  // same color, so on a bg-primary button (Save, etc.) a flush ring is
  // invisible — the offset punches a background-colored gap between the
  // button edge and the ring so it actually shows up.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // One standard height across the whole app — sizes below only vary
        // padding/text, not height, so mixing them never produces a visibly
        // taller/shorter button by accident.
        //
        // TWO standard heights, strictly: 32px from `sm:` up, and 44px below
        // it. A 32px button is comfortable under a mouse and a miss under a
        // thumb — the shop bills from a phone all day, and every Save, Cancel
        // and Add on it was smaller than the finger pressing it. 44px is the
        // figure both Apple and Google publish, and it is the same number for
        // every button here for the same reason the old one was: so nothing
        // is accidentally a different size.
        default: "h-11 px-4 py-2 sm:h-8",
        sm: "h-11 rounded-md px-3 text-sm sm:h-8 sm:text-xs",
        lg: "h-11 rounded-md px-8 sm:h-8",
        icon: "h-11 w-11 sm:h-8 sm:w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        // Explicit tabindex: macOS Safari skips <button> elements when
        // Tabbing unless tabindex is set — without this, keyboard users on
        // Mac can never Tab to Save/Cancel in any form or dialog.
        tabIndex={0}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
