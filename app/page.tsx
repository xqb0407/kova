import { AppRuntimeProvider } from "@/components/runtime/app-runtime-provider";
import { Base } from "@/components/agent-thread/base";

export default function Page() {
  return (
    <main className="h-dvh overflow-hidden">
      <AppRuntimeProvider>
        <Base />
      </AppRuntimeProvider>
    </main>
  );
}
