import { useOutletContext } from "react-router";
import type { Org } from "@zippy/shared";
import { useOrgs } from "@/lib/api";
import { useUI } from "@/lib/store";

// Outlet context is absent outside routes (e.g. sidebar dialogs)
export const useOrg = () => {
  const ctx = useOutletContext<{ org: Org } | undefined>();
  const { data: orgs = [] } = useOrgs();
  const { orgId } = useUI();
  return ctx?.org ?? orgs.find((o) => o.id === orgId) ?? orgs[0]!;
};
