import { type PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

// Use PropsWithChildren for type safety with the built-in children prop
// Merge with other props like `className`
type ContainerProps = PropsWithChildren<{
    className?: string;
}>;

const Container = ({ children, className }: ContainerProps) => {
    // Define base Tailwind styles for the container
    const baseClasses = "mx-auto max-w-7xl px-4 sm:px-6 lg:px-4";

    // Merge base classes with any custom classes passed in
    const combinedClasses = cn(baseClasses, className);

    return <div className={combinedClasses}>{children}</div>;
};

export default Container;
