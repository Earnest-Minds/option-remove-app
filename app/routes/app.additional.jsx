import React, { useEffect, useMemo, useRef, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Banner,
  TextField,
  ResourceList,
  ResourceItem,
  Button,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// 1) Fetch existing products and their options
const PRODUCTS_QUERY = `#graphql
  query AllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          options { id name }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

// 2) Add a new option to a product (no variant creation)
const ADD_OPTION_MUTATION = `#graphql
  mutation addOption($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(
      productId: $productId,
      options: $options,
      variantStrategy: LEAVE_AS_IS
    ) {
      userErrors { field message }
    }
  }
`;

// Load all products
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const all = [];
  let hasNext = true;
  let cursor = null;

  console.log("[Loader] Starting fetch of all products");
  while (hasNext) {
    const resp = await admin.graphql(PRODUCTS_QUERY, { variables: { first: 250, after: cursor } });
    const { data } = await resp.json();
    data.products.edges.forEach(({ node }) => all.push(node));
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = hasNext ? data.products.edges.at(-1).cursor : null;
    console.log(`[Loader] Fetched batch, total so far: ${all.length}, hasNext: ${hasNext}`);
  }

  console.log(`[Loader] Completed fetch, total products: ${all.length}`);
  return json({ products: all });
};

// Action to add option to all missing products
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const optionName = form.get("optionName")?.toString().trim() || "";
  const valuesJSON = form.get("values")?.toString() || "";

  console.log("[Action] Received optionName:", optionName);
  console.log("[Action] Received valuesJSON:", valuesJSON);

  if (!optionName) {
    console.log("[Action] No optionName provided");
    return json({ success: false, error: "Please enter an option name." });
  }
  if (!valuesJSON) {
    console.log("[Action] No values provided");
    return json({ success: false, error: "Please provide three values." });
  }

  let values;
  try {
    values = JSON.parse(valuesJSON);
    console.log("[Action] Parsed values:", values);
  } catch (e) {
    console.error("[Action] Error parsing valuesJSON", e);
    return json({ success: false, error: "Invalid values format." });
  }

  // re-fetch products
  const all = [];
  let hasNext = true;
  let cursor = null;
  while (hasNext) {
    const resp = await admin.graphql(PRODUCTS_QUERY, { variables: { first: 250, after: cursor } });
    const { data } = await resp.json();
    data.products.edges.forEach(({ node }) => all.push(node));
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = hasNext ? data.products.edges.at(-1).cursor : null;
  }
  console.log(`[Action] Total products refetched: ${all.length}`);

  // filter for products missing this option
  const toAdd = all.filter(p =>
    !p.options.some(o => o.name.toLowerCase() === optionName.toLowerCase())
  );
  console.log(`[Action] Products missing "${optionName}": ${toAdd.length}`);

  const errors = [];
  for (const prod of toAdd) {
    console.log(`[Action] Adding option to product: ${prod.id} - ${prod.title}`);
    const optionInput = [{ name: optionName, values: values.map(v => ({ name: v })) }];
    const resp = await admin.graphql(ADD_OPTION_MUTATION, {
      variables: { productId: prod.id, options: optionInput },
    });
    const result = await resp.json();
    const userErrors = result.data.productOptionsCreate.userErrors;
    if (userErrors.length) {
      console.error(`[Action] Errors for ${prod.id}:`, userErrors);
      errors.push(...userErrors.map(e => e.message));
    } else {
      console.log(`[Action] Successfully added to ${prod.id}`);
    }
  }

  if (errors.length) {
    console.error("[Action] Completed with errors:", errors);
    return json({ success: false, error: errors.join("; ") });
  }

  console.log(`[Action] All done, added to ${toAdd.length} products`);
  return json({ success: true, addedCount: toAdd.length });
};

// UI
export default function Index() {
  const { products } = useLoaderData();
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [optionName, setOptionName] = useState("");
  const [values, setValues] = useState(["", "", ""]);

  const missing = useMemo(() => {
    if (!optionName.trim()) return [];
    return products.filter(p =>
      !p.options.some(o => o.name.toLowerCase() === optionName.toLowerCase())
    );
  }, [products, optionName]);

  // Toasts
  useEffect(() => {
    if (fetcher.data?.error) app.toast.show(fetcher.data.error, { error: true });
    else if (fetcher.data?.success) {
      const count = fetcher.data.addedCount;
      app.toast.show(
        `Added "${optionName}" to ${count} product${count !== 1 ? 's' : ''}`
      );
      setOptionName("");
      setValues(["", "", ""]);
    }
  }, [fetcher.data]);

  return (
    <Page>
      <TitleBar title="Add Option to Products" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <TextField
              label="Option name"
              placeholder="e.g. Color"
              value={optionName}
              onChange={v => {
                console.log("[UI] optionName changed:", v);
                setOptionName(v);
              }}
              clearButton
              onClearButtonClick={() => {
                console.log("[UI] optionName cleared");
                setOptionName("");
              }}
            />

            <Banner status="info">
              <Text>
                {optionName
                  ? `${missing.length} product${missing.length !== 1 ? 's' : ''} missing "${optionName}"`
                  : 'Enter an option name above'}
              </Text>
            </Banner>

            {missing.length > 0 && (
              <>
                {[0, 1, 2].map(i => (
                  <TextField
                    key={i}
                    label={`Value ${i + 1}`}
                    placeholder={["Red", "Green", "Yellow"][i]}
                    value={values[i]}
                    onChange={v => {
                      console.log(`[UI] values[${i}] changed to:`, v);
                      const next = [...values];
                      next[i] = v;
                      setValues(next);
                    }}
                  />
                ))}

                <Button
                  primary
                  loading={fetcher.state === "submitting"}
                  disabled={fetcher.state === "submitting" || values.some(v => !v)}
                  onClick={() => {
                    console.log("[UI] Submitting add-option with", { optionName, values });
                    fetcher.submit(
                      { optionName, values: JSON.stringify(values) },
                      { method: "post" }
                    );
                  }}
                >
                  Add "{optionName}" to {missing.length} products
                </Button>

                <ResourceList
                  resourceName={{ singular: 'product', plural: 'products' }}
                  items={missing.map(p => ({ id: p.id, title: p.title }))}
                  renderItem={({ id, title }) => (
                    <ResourceItem id={id}>
                      <Text>{title}</Text>
                    </ResourceItem>
                  )}
                />
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}